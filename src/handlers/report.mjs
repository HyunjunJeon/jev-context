// A subagent's report lands whole in the orchestrator's window. The hook asks
// every worker, when it is spawned, to open its report with a short Summary and
// put the rest under Details; at hand-back it keeps the full report in a file
// and delivers only the Summary and the path - no extra round. A report without
// that shape and over budget is sent back once to be shortened. The hook saves
// the file itself: Claude Code refuses report files written by subagents.
//
// No Jev here: replayed on 112 real briefs, Jev put 93% in one detail level, so
// a fixed budget does the same job.
//
// Claude Code 2.1.284 delivers a report only through a SubagentHandback tool
// call ("plain text you write at the end is not delivered"), so the guard sits
// on that call (PreToolUse). Hosts without it (Codex) deliver the final
// message, guarded at SubagentStop.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readState, saveText, writeState } from '../core/io.mjs';
import * as claude from '../transcript/claude.mjs';
import * as codex from '../transcript/codex.mjs';

const HANDBACK = 'SubagentHandback';
const GUIDE_MARK = '[jev-context report format]';
const SUMMARY = /^#{1,3}\s*(?:summary|요약)\s*$/im;
const DETAILS = /^#{1,3}\s*(?:details|세부|상세)\b.*$/im;

/** PreToolUse(Agent|Task): ask the worker for a Summary/Details report. Only the worker sees it. */
export function spawnGuidance(cfg, event) {
  const entry = { decision: 'off' };
  if (cfg.reportSplit !== 'on') return { entry };
  const input = event.tool_input ?? {};
  entry.decision = 'already_guided';
  if (typeof input.prompt !== 'string' || input.prompt.includes(GUIDE_MARK)) return { entry };
  entry.decision = 'guided';
  const guide = `\n\n${GUIDE_MARK} Start your final report with a "## Summary" section of at most ${cfg.reportSummaryChars} characters: `
    + 'the outcome, commit ids, test or CI status, anything blocking, and what the caller must decide. Put everything else under "## Details". '
    + 'The caller receives the Summary; the harness keeps the full report in a file and gives the caller its path.';
  return { entry, output: { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, prompt: input.prompt + guide } } } };
}

/** The Summary section of a Summary/Details report, or null. */
export function summaryOf(report) {
  const start = report.search(SUMMARY);
  const end = report.search(DETAILS);
  if (start === -1 || end === -1 || end <= start) return null;
  return report.slice(start, end).trim();
}

function archiveFor(cfg, event) {
  const base = event.agent_transcript_path ? dirname(event.agent_transcript_path)
    : event.transcript_path ? join(dirname(event.transcript_path), String(event.session_id), 'subagents')
      : join(event.cwd ?? cfg.stateDir, '.jev-context', 'reports');
  return join(base, `agent-${event.agent_id ?? 'unknown'}-report-${Date.now()}.md`);
}

function shortenRequest(chars, path, limit, how) {
  return `Your report is ${chars} characters. The harness has saved it in full at ${path}. `
    + `${how} at most ${limit} characters: the conclusions and the next actions the caller needs, `
    + `then the path on its own line so the caller can read the details.`;
}

/**
 * PreToolUse(SubagentHandback) in Claude Code: deliver only the Summary of a
 * Summary/Details report (full report saved), or send an over-budget report
 * without that shape back once.
 */
export function handback(cfg, event) {
  const report = String(event.tool_input?.message ?? '');
  const key = `handback-${event.session_id}-${event.agent_id ?? 'main'}`;
  const entry = { decision: 'within_budget', reportChars: report.length, agentType: event.agent_type };
  const summary = cfg.reportSplit === 'on' ? summaryOf(report) : null;
  if (summary && summary.length <= cfg.reportSummaryChars * 1.3 && report.length - summary.length > 200) {
    const archive = archiveFor(cfg, event);
    try {
      saveText(archive, report);
    } catch {
      entry.decision = 'archive_failed';
      return { entry };
    }
    const delivered = `${summary}\n\n[jev-context: the full report (${report.length} chars, with Details) is saved at ${archive}; read it when you need the details]`;
    Object.assign(entry, { decision: 'split', deliveredChars: delivered.length, archive });
    return { entry, output: { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...event.tool_input, message: delivered } } } };
  }
  if (report.length <= cfg.reportMaxChars) return { entry };
  entry.decision = 'already_asked';
  if (readState(cfg, key).asked) return { entry };
  const path = archiveFor(cfg, event);
  try {
    saveText(path, report);
  } catch {
    entry.decision = 'archive_failed';
    return { entry };
  }
  writeState(cfg, key, { asked: true, path });
  Object.assign(entry, { decision: 'asked_to_shorten', archive: path });
  return {
    entry,
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${shortenRequest(report.length, path, cfg.reportSummaryChars, `Call ${HANDBACK} again with a "## Summary" section of`)} Put the rest under "## Details" in the same message: the caller receives only the Summary and the path.`,
      },
    },
  };
}

// The host tells a subagent up front ("Your final report is delivered through
// SubagentHandback"), so the mode shows in its transcript before any call.
// "SubagentHandback is not available in this run" names the tool too, and
// means the opposite.
function handbackMode(path) {
  if (!path || !existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  return text.includes(`delivered through ${HANDBACK}`) || text.includes(`"name":"${HANDBACK}"`);
}

export function subagentStop(cfg, event, host) {
  const entry = { decision: 'already_asked', agentType: event.agent_type };
  if (event.stop_hook_active) return { entry };
  // No agent type: the host's own helper (Claude Code's /compact summarizer
  // runs this way). Its output is not a report and must not be touched.
  entry.decision = 'internal_agent';
  if (!event.agent_type) return { entry };
  // The report goes through SubagentHandback; the final text is not delivered.
  entry.decision = 'handback_mode';
  if (host === 'claude' && handbackMode(event.agent_transcript_path)) return { entry };
  const read = host === 'codex' ? codex : claude;
  const report = read.finalReport(event.agent_transcript_path, event.last_assistant_message ?? '');
  Object.assign(entry, { reportChars: report.length, decision: 'within_budget' });
  if (report.length <= cfg.reportMaxChars) return { entry };
  const path = archiveFor(cfg, event);
  try {
    saveText(path, report);
  } catch {
    entry.decision = 'archive_failed';
    return { entry };
  }
  const limit = Math.round(cfg.reportMaxChars / 2);
  entry.decision = 'asked_to_shorten';
  entry.archive = path;
  return {
    entry,
    output: {
      decision: 'block',
      reason: `${shortenRequest(report.length, path, limit, 'Replace it with a final message of')} Do not call tools.`,
    },
  };
}
