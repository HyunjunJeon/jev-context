// Claude Code only: compact when the prompt cache is already gone, when doing
// so costs no cache. Codex exposes no cache-expiry signal to hooks.
import { duration, kTokens, readState, writeState } from '../core/io.mjs';
import { lastResponse, lostCompaction, readEntries } from '../transcript/claude.mjs';

const RESUME_GRACE_MS = 10 * 60 * 1000;
const stateKey = (event) => `timing-${event.session_id}`;

// SessionStart(resume|fork) carries prompt_cache_likely_expired. Only a
// headless run (claude -p, the SDK) submits initialUserMessage; an
// interactive --resume shows the message and drops it (2.1.284).
export function onResume(cfg, event) {
  const lost = cfg.resume === 'off' ? null : lostCompaction(event.transcript_path);
  if (lost) return onLostCompaction(cfg, event, lost);
  const seconds = event.seconds_since_last_response;
  const tokens = event.context_tokens;
  const headless = (process.env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');
  const expired = event.prompt_cache_likely_expired === true || seconds >= cfg.assumeExpiredAfter;
  let decision = 'compact';
  if (cfg.resume === 'off') decision = 'off';
  else if (tokens === undefined) decision = 'no_usage';
  else if (!expired) decision = 'cache_warm';
  else if (tokens < cfg.compactMinTokens) decision = 'below_min_tokens';
  else if (!headless) decision = 'notify';
  const entry = { decision, secondsSinceLastResponse: seconds, contextTokens: tokens, estimatedCacheWriteUsd: event.estimated_cache_write_usd };
  const cost = event.estimated_cache_write_usd === undefined ? '' : ` · re-caching ≈ $${event.estimated_cache_write_usd.toFixed(2)}`;
  const status = `jev-context: prompt cache expired (${duration(seconds ?? 0)} idle) · context ${kTokens(tokens ?? 0)}${cost}`;
  if (decision === 'compact') {
    writeState(cfg, stateKey(event), { compactQueuedAt: Date.now() });
    return { entry, output: { systemMessage: `${status} → /compact first`, hookSpecificOutput: { hookEventName: 'SessionStart', initialUserMessage: '/compact' } } };
  }
  if (decision === 'notify') return { entry, output: { systemMessage: `${status} → run /compact before the next request` } };
  return { entry };
}

// A compaction the resume undid (see lostCompaction). The hook input still
// reports the compacted context as warm, but the next request re-sends the
// whole history uncached, so this is the cold-cache case whatever it says.
function onLostCompaction(cfg, event, lost) {
  const headless = (process.env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');
  const entry = { decision: headless ? 'compact' : 'notify', reason: 'compaction_lost', preTokens: lost.preTokens, postTokens: lost.postTokens, contextTokens: event.context_tokens };
  const status = `jev-context: the last compaction (${kTokens(lost.preTokens ?? 0)} → ${kTokens(lost.postTokens ?? 0)}) did not survive the resume; the next request re-sends about ${kTokens(lost.preTokens ?? 0)} tokens uncached`;
  if (headless) {
    writeState(cfg, stateKey(event), { compactQueuedAt: Date.now() });
    return { entry, output: { systemMessage: `${status} → /compact first`, hookSpecificOutput: { hookEventName: 'SessionStart', initialUserMessage: '/compact' } } };
  }
  writeState(cfg, stateKey(event), { compactionLost: lost });
  return { entry, output: { systemMessage: `${status} → run /compact before the next request` } };
}

// UserPromptSubmit: the same cold-cache moment inside a running session. A
// hook cannot start /compact here, so it stops the prompt once and says why.
export function onPrompt(cfg, event) {
  const entry = { decision: cfg.idle };
  if (cfg.idle === 'off') return { entry };
  const state = readState(cfg, stateKey(event));
  entry.decision = 'compact_queued';
  if (state.compactQueuedAt && Date.now() - state.compactQueuedAt < RESUME_GRACE_MS) return { entry };
  if (state.compactionLost && cfg.idle === 'block-once') {
    // Stop the first prompt once; after that, or after a /compact, it is gone.
    writeState(cfg, stateKey(event), { ...state, compactionLost: undefined });
    // A /compact since then made a new boundary; that one only goes on the next resume.
    if (lostCompaction(event.transcript_path)?.boundary !== state.compactionLost.boundary) return { entry: { ...entry, decision: 'compacted_since' } };
    const tokens = kTokens(state.compactionLost.preTokens ?? 0);
    return { entry: { ...entry, decision: 'blocked', reason: 'compaction_lost' }, output: { decision: 'block', reason: `jev-context: the resume undid the last compaction, so this prompt would re-send about ${tokens} tokens uncached. Run /compact first, or submit the same prompt again to send it as it is.` } };
  }
  const last = lastResponse(readEntries(event.transcript_path));
  entry.decision = 'no_usage';
  if (!last) return { entry };
  const ttl = cfg.ttlSeconds ?? last.ttlSeconds ?? 300;
  const idle = (Date.now() - last.at) / 1000;
  Object.assign(entry, { idleSeconds: Math.round(idle), ttlSeconds: ttl, contextTokens: last.contextTokens, decision: 'cache_warm' });
  if (idle < ttl && idle < cfg.assumeExpiredAfter) return { entry };
  entry.decision = 'below_min_tokens';
  if (last.contextTokens < cfg.compactMinTokens) return { entry };
  const message = `jev-context: ${duration(idle)} since the last response, so the prompt cache (TTL ${duration(ttl)}) has expired. `
    + `Sending now re-caches all ${kTokens(last.contextTokens)} tokens; after /compact only the smaller context is re-cached.`;
  if (cfg.idle === 'warn') {
    entry.decision = 'warned';
    return { entry, output: { systemMessage: message } };
  }
  entry.decision = 'nudged_already';
  if (state.nudgedFor === last.at) return { entry };
  writeState(cfg, stateKey(event), { ...state, nudgedFor: last.at });
  entry.decision = 'blocked';
  return { entry, output: { decision: 'block', reason: `${message} To send it as it is, submit the same prompt again.` } };
}
