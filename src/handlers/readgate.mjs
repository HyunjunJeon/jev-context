// PreToolUse(Bash|Read), main session only: a subagent's window is thrown away
// after its report, so gating its reads costs time without delaying the
// orchestrator's compaction.
import { createHash } from 'node:crypto';
import { readState, writeState } from '../core/io.mjs';
import { assessRead, denyMessage, readRequest, readToolRequest, sizeRequest } from '../core/readgate.mjs';
import * as claude from '../transcript/claude.mjs';
import * as codex from '../transcript/codex.mjs';

export async function readGate(cfg, event, host) {
  const entry = { decision: 'off' };
  if (cfg.readGate === 'off') return { entry };
  entry.decision = 'subagent';
  if (event.agent_id) return { entry };
  const input = event.tool_input ?? {};
  const command = event.tool_name === 'Read' ? null : String(input.command ?? '');
  const request = event.tool_name === 'Read' ? readToolRequest(input, event.cwd) : readRequest(command, event.cwd);
  entry.decision = 'not_a_sized_read';
  if (!request) return { entry };
  const size = sizeRequest(request);
  entry.decision = 'unknown_size';
  if (!size) return { entry };
  Object.assign(entry, { lines: size.count, total: size.total });
  entry.decision = 'below_threshold';
  if (size.count < cfg.readGateLines) return { entry };
  // Asking again is the agent's answer that it needs the whole range.
  const key = `readgate-${event.session_id}-${createHash('sha256').update(`${request.file}:${size.from}:${size.to}`).digest('hex').slice(0, 16)}`;
  entry.decision = 'repeated';
  if (readState(cfg, key).denied) return { entry };
  const { messages } = host === 'codex'
    ? codex.conversation(event.transcript_path, { limit: 20 })
    : claude.conversation(claude.readEntries(event.transcript_path), { limit: 20 });
  // Replayed on real sessions, Jev's verdicts tracked what went unused only when
  // the purpose was visible: text with the call, or a request just made.
  const intent = claude.intentEvidence(messages);
  Object.assign(entry, intent);
  entry.decision = 'no_intent';
  if (cfg.readGateIntent === 'on' && intent.ownText < 40 && intent.since > 3) return { entry };
  const verdict = await assessRead(cfg, { command, file: request.file, size, goal: claude.goalOf(messages), messages });
  if (verdict.skipped) {
    entry.decision = verdict.skipped;
    return { entry };
  }
  Object.assign(entry, { p: Number(verdict.p.toFixed(3)), outline: verdict.outline.length, jevRequests: verdict.requests });
  entry.decision = 'needed';
  if (verdict.needed) return { entry };
  writeState(cfg, key, { denied: Date.now() });
  entry.decision = 'denied';
  return {
    entry,
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage({ file: request.file, size, p: verdict.p, outline: verdict.outline, command }),
      },
    },
  };
}
