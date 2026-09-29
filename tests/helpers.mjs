import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const tmp = () => mkdtempSync(join(tmpdir(), 'jev-context-'));

export function labeledLog() {
  const lines = ['BUILD START seminar-bundle'];
  for (let i = 1; i <= 1800; i += 1) {
    lines.push(`cache entry ${String(i).padStart(4, '0')} reused unchanged object from local incremental build; progress only; no new diagnostic or artifact`);
    if (i === 900) lines.push('BUNDLE Q7 = sha256:7e4c9a (required for handoff)');
    if (i === 1200) lines.push('ROLLBACK TARGET = stable-snapshot (required for handoff)');
  }
  lines.push('Build completed successfully: 1 bundle, 0 errors');
  return `${lines.join('\n')}\n`;
}

export function neutralLog(count = 1800, q7At = 900, rollbackAt = 1200) {
  const mods = ['audit', 'fx', 'ledger', 'payout', 'refund', 'invoice', 'kyc', 'settle'];
  const lines = ['> seminar-bundle@4.18.2 build', '> tsc -b && node scripts/bundle.mjs'];
  for (let i = 1; i <= count; i += 1) {
    const hash = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 6);
    lines.push(`[bundle] chunk ${String(i).padStart(4, '0')} ${mods[i % mods.length]}-${hash}.js reused from incremental cache (${(i % 29) + 2} kB)`);
    if (i === q7At) lines.push('[release] bundle Q7 digest sha256:7e4c9a');
    if (i === rollbackAt) lines.push('[release] rollback target stable-snapshot');
  }
  lines.push('Build completed: 1 bundle, 0 errors');
  return `${lines.join('\n')}\n`;
}

export function claudeTranscript(dir, { ageSeconds = 30, ttl = '1h', contextTokens = 120_000, results = [], silentTurns = 0, finalText = 'Done.' } = {}) {
  const at = (offset) => new Date(Date.now() - offset * 1000).toISOString();
  const usage = {
    input_tokens: 2,
    cache_read_input_tokens: contextTokens - 1002,
    cache_creation_input_tokens: 900,
    output_tokens: 100,
    cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? 900 : 0, ephemeral_5m_input_tokens: ttl === '5m' ? 900 : 0 },
  };
  const lines = [{ type: 'user', timestamp: at(ageSeconds + 9), message: { role: 'user', content: 'Build it and keep the bundle digest for the handoff.' } }];
  results.forEach(([command, text], i) => {
    lines.push({ type: 'assistant', timestamp: at(ageSeconds + 5), message: { id: `m${i}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }], usage } });
    lines.push({ type: 'user', timestamp: at(ageSeconds + 4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: text }] } });
  });
  // Responses that only call tools, as in a long run with no narration.
  for (let i = 0; i < silentTurns; i += 1) {
    lines.push({ type: 'assistant', timestamp: at(ageSeconds + 2), message: { id: `s${i}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `st${i}`, name: 'Bash', input: { command: 'ls' } }], usage } });
    lines.push({ type: 'user', timestamp: at(ageSeconds + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `st${i}`, content: 'a b c' }] } });
  }
  lines.push({ type: 'assistant', timestamp: at(ageSeconds), message: { id: 'final', role: 'assistant', model: 'claude-sonnet-5-5', content: finalText ? [{ type: 'text', text: finalText }] : [], usage } });
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  return path;
}

/** Runs bin/hook.mjs like a host would; returns its JSON answer and log line. */
export function hook(host, name, event, { dir, env = {} }) {
  const result = spawnSync('node', [join(root, 'bin/hook.mjs'), host, name], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      JEV_CONTEXT_LOG: join(dir, 'log.jsonl'),
      JEV_CONTEXT_STATE_DIR: join(dir, 'state'),
      JEV_CONTEXT_JEV: 'simulated',
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).at(-1);
  assert.notEqual(log.decision, 'hook_error', log.error);
  return { output: result.stdout ? JSON.parse(result.stdout) : null, log };
}

export const cfgFor = (dir, overrides = {}) => ({
  root,
  jev: 'simulated',
  jevModel: 'jev-latest',
  prune: 'on',
  pruneMinChars: 4_000,
  pruneMinSaving: 0.25,
  pruneMaxChars: 8_000,
  reportMaxChars: 3_000,
  reportSplit: 'on',
  reportSummaryChars: 1_500,
  retain: 'on',
  retainMaxChars: 6_000,
  resume: 'compact',
  idle: 'block-once',
  compactMinTokens: 60_000,
  ttlSeconds: null,
  assumeExpiredAfter: Infinity,
  codexWrap: 'off',
  log: join(dir, 'log.jsonl'),
  stateDir: join(dir, 'state'),
  ...overrides,
});
