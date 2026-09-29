import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeTranscript, hook, tmp } from './helpers.mjs';

const resume = (fields) => ({ session_id: 's2', hook_event_name: 'SessionStart', source: 'resume', seconds_since_last_response: 4000, context_tokens: 150_000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 0.9, ...fields });
const prompt = (path) => ({ session_id: 's2', hook_event_name: 'UserPromptSubmit', transcript_path: path, prompt: 'continue' });

test('headless resume compacts first only when the cache is gone and the context is large', () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
  let dir = tmp();
  const cold = hook('claude', 'session-start', resume({}), { dir, env });
  assert.equal(cold.output.hookSpecificOutput.initialUserMessage, '/compact');
  assert.match(cold.output.systemMessage, /67min idle.*150k.*\$0\.90/);
  dir = tmp();
  assert.equal(hook('claude', 'session-start', resume({ prompt_cache_likely_expired: false, seconds_since_last_response: 60 }), { dir, env }).log.decision, 'cache_warm');
  dir = tmp();
  assert.equal(hook('claude', 'session-start', resume({ context_tokens: 20_000 }), { dir, env }).log.decision, 'below_min_tokens');
});

test('interactive resume only reports the cost; the first prompt is stopped once, then passes', () => {
  const dir = tmp();
  const notice = hook('claude', 'session-start', resume({}), { dir, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  assert.equal(notice.log.decision, 'notify');
  assert.equal(notice.output.hookSpecificOutput, undefined);
  const path = claudeTranscript(dir, { ageSeconds: 7200 });
  const first = hook('claude', 'user-prompt-submit', prompt(path), { dir });
  assert.equal(first.output.decision, 'block');
  assert.match(first.output.reason, /120min.*TTL 60min.*120k/);
  const second = hook('claude', 'user-prompt-submit', prompt(path), { dir });
  assert.equal(second.output, null);
  assert.equal(second.log.decision, 'nudged_already');
});

test('the idle guard reads the TTL from the transcript and stays quiet while the cache is warm', () => {
  let dir = tmp();
  assert.equal(hook('claude', 'user-prompt-submit', prompt(claudeTranscript(dir, { ageSeconds: 600 })), { dir }).log.decision, 'cache_warm');
  dir = tmp();
  const fiveMinute = hook('claude', 'user-prompt-submit', prompt(claudeTranscript(dir, { ageSeconds: 600, ttl: '5m' })), { dir });
  assert.equal(fiveMinute.log.ttlSeconds, 300);
  assert.equal(fiveMinute.log.decision, 'blocked');
  dir = tmp();
  assert.equal(hook('claude', 'user-prompt-submit', prompt(join(dir, 'not-yet.jsonl')), { dir }).log.decision, 'no_usage');
});

test('codex gets no timing hooks: it exposes no cache-expiry signal', () => {
  const dir = tmp();
  assert.equal(hook('codex', 'session-start', resume({}), { dir }).log.decision, 'not_applicable');
});

// Entries shaped like a 2.1.284 transcript after a compaction: `kept` says
// whether a result that survived points back into the old chain (function
// hook) or everything after the boundary is a fresh chain (built-in summary).
function compactedTranscript(dir, { oldParents, extraBoundary = false }) {
  const e = (uuid, parentUuid, type = 'user', extra = {}) => ({ type, uuid, parentUuid, message: { role: type, content: 'x' }, ...extra });
  const usage = { input_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 100, output_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 100 } };
  const boundary = (uuid) => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: 'o4', compactMetadata: { preTokens: 196_398, postTokens: 18_295 } });
  const lines = [e('o1', null), e('o2', 'o1', 'assistant'), e('o3', 'o2'), e('o4', 'o3', 'assistant'), boundary('b1'),
    e('k1', 'b1'), e('k2', oldParents ? 'o2' : 'k1'),
    e('k3', 'k2', 'assistant', { timestamp: new Date(Date.now() - 5_000).toISOString(), message: { id: 'm', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage } })];
  if (extraBoundary) lines.push(boundary('b2'), e('n1', 'b2'), e('n2', 'n1', 'assistant'));
  const path = join(dir, 'compacted.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

test('a compaction the resume undid is treated as a cold cache, whatever the hook input says', () => {
  const warm = { prompt_cache_likely_expired: false, seconds_since_last_response: 1, context_tokens: 52_667 };
  let dir = tmp();
  const headless = hook('claude', 'session-start', resume({ ...warm, transcript_path: compactedTranscript(dir, { oldParents: true }) }), { dir, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
  assert.equal(headless.output.hookSpecificOutput.initialUserMessage, '/compact');
  assert.equal(headless.log.reason, 'compaction_lost');
  assert.match(headless.output.systemMessage, /196k → 18k.*did not survive/);

  dir = tmp();
  const survived = hook('claude', 'session-start', resume({ ...warm, transcript_path: compactedTranscript(dir, { oldParents: false }) }), { dir, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
  assert.equal(survived.log.decision, 'cache_warm', 'a built-in summary survives resume');

  dir = tmp();
  const path = compactedTranscript(dir, { oldParents: true });
  assert.equal(hook('claude', 'session-start', resume({ ...warm, transcript_path: path }), { dir, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }).log.decision, 'notify');
  const first = hook('claude', 'user-prompt-submit', prompt(path), { dir });
  assert.equal(first.output.decision, 'block');
  assert.match(first.output.reason, /undid the last compaction.*196k/);
  assert.notEqual(hook('claude', 'user-prompt-submit', prompt(path), { dir }).output?.decision, 'block');

  dir = tmp();
  const again = compactedTranscript(dir, { oldParents: true });
  hook('claude', 'session-start', resume({ ...warm, transcript_path: again }), { dir, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  const since = hook('claude', 'user-prompt-submit', prompt(compactedTranscript(dir, { oldParents: true, extraBoundary: true })), { dir });
  assert.equal(since.log.decision, 'compacted_since');
});
