// PreCompact picks the exact text to carry over; SessionStart(compact) appends
// it after the host's summary. A compaction resets the cache anyway, and the
// appended text becomes part of the new prefix, so nothing already cached or
// any later thinking block sees an edit.
import { existsSync } from 'node:fs';
import { carryWhole, renderCarried } from '../core/carry.mjs';
import { clearState, readState, writeState } from '../core/io.mjs';
import { asker } from '../core/jev.mjs';
import { hybridFacts, renderFacts, selectFacts, standoutFacts } from '../core/retain.mjs';
import * as claude from '../transcript/claude.mjs';
import * as codex from '../transcript/codex.mjs';

const FRESH_MS = 15 * 60 * 1000;
const key = (event) => `retain-${event.session_id}`;

export async function preCompact(cfg, event, host) {
  const entry = { decision: 'off', trigger: event.trigger };
  if (cfg.retain === 'off') return { entry };
  // A forked session's file is written on its first entry: compacting straight
  // after `--fork-session` finds nothing to read (Claude Code 2.1.284, measured).
  if (!existsSync(event.transcript_path ?? '')) return { entry: { ...entry, decision: 'no_transcript' } };
  // The whole conversation since the last compaction: Jev's state is fitted to size.
  const { messages, results } = host === 'codex'
    ? codex.conversation(event.transcript_path, { limit: 400 })
    : claude.conversation(claude.readEntries(event.transcript_path), { limit: 400 });
  const goal = claude.goalOf(messages);
  // `on` (default): standout lines by rule, plus the outputs Jev says the next
  // step works on, carried whole (one request, only when an output is large
  // enough to matter). `rules`: standout lines only.
  let carried = { facts: [], stage: 'off' };
  if (cfg.retain === 'on') {
    try {
      carried = await carryWhole(cfg, { messages, results, jev: asker(cfg) });
    } catch (error) {
      carried = { facts: [], stage: 'jev_error', jevError: String(error?.message ?? error).slice(0, 200) };
    }
  }
  const whole = new Set(carried.facts.map((f) => f.result));
  const rest = results.map((r, i) => (whole.has(i) ? { ...r, text: '' } : r));
  const selection = cfg.retain === 'jev'
    ? await selectFacts(cfg, { results, messages, goal })
    : cfg.retain === 'hybrid'
      ? await hybridFacts(cfg, { results, messages, goal })
      : standoutFacts(cfg, { results: rest });
  const picker = cfg.retain === 'jev' || cfg.retain === 'hybrid' ? cfg.retain : cfg.retain === 'on' ? 'rules+carry' : 'rules';
  Object.assign(entry, {
    decision: selection.stage,
    picker,
    results: results.length,
    chunks: selection.chunks,
    facts: selection.facts.length,
    chars: selection.chars,
    ruleFacts: selection.ruleFacts,
    semanticFacts: selection.semanticFacts,
    jevStage: selection.jevStage,
    jevRequests: selection.jevRequests,
    jevError: selection.jevError ?? carried.jevError,
    carry: carried.stage,
    carryAsked: carried.asked,
    carried: carried.facts.length,
    carryChars: carried.chars,
    carryScores: carried.scores,
  });
  if (carried.jevRequests !== undefined) entry.jevRequests = (entry.jevRequests ?? 0) + carried.jevRequests;
  if (selection.facts.length + carried.facts.length > 0) entry.decision = 'selected';
  const parts = [selection.facts.length ? renderFacts(selection.facts) : '', carried.facts.length ? renderCarried(carried.facts) : ''].filter(Boolean);
  if (parts.length) writeState(cfg, key(event), { at: Date.now(), text: parts.join('\n\n') });
  return { entry };
}

export function injectAfterCompact(cfg, event) {
  const entry = { decision: 'nothing_kept' };
  const state = readState(cfg, key(event));
  clearState(cfg, key(event));
  if (!state.text) return { entry };
  entry.decision = 'stale';
  if (Date.now() - state.at > FRESH_MS) return { entry };
  entry.decision = 'injected';
  entry.chars = state.text.length;
  return { entry, output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: state.text } } };
}
