import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { outline, readRequest, readToolRequest, sizeRequest } from '../src/core/readgate.mjs';
import { claudeTranscript, hook, tmp } from './helpers.mjs';

function doc(dir, lines = 300) {
  const body = Array.from({ length: lines }, (_, i) => (i % 50 === 0 ? `## Section ${i / 50 + 1}` : `line ${i + 1} of the guide`));
  body.splice(10, 0, '```sh', '# not a heading', '```');
  writeFileSync(join(dir, 'guide.md'), body.join('\n'));
  return join(dir, 'guide.md');
}

test('read requests are sized before they run; anything unclear is left alone', () => {
  const dir = tmp();
  doc(dir);
  const size = (command) => sizeRequest(readRequest(command, dir));
  assert.equal(size('cat guide.md').count, 303);
  assert.deepEqual([size("sed -n '20,79p' guide.md").from, size("sed -n '20,79p' guide.md").count], [20, 60]);
  assert.equal(size('head -n 40 guide.md').count, 40);
  assert.equal(size('tail -25 guide.md').from, 279);
  assert.equal(size(`cd ${dir} && cat guide.md`).count, 303);
  for (const unclear of ['cat guide.md | grep x', 'cat a.md b.md', 'grep -n x guide.md', 'cat *.md', 'cat missing.md']) assert.equal(size(unclear), null, unclear);
  assert.equal(sizeRequest(readToolRequest({ file_path: 'guide.md', offset: 100, limit: 30 }, dir)).count, 30);
});

test('the outline lists headings and definitions with line numbers, not fenced code', () => {
  const dir = tmp();
  doc(dir);
  const md = sizeRequest(readRequest('cat guide.md', dir));
  const entries = outline(md.lines, 'guide.md');
  assert.ok(entries.some((e) => /^\s+1: ## Section 1$/.test(e)));
  assert.ok(!entries.some((e) => e.includes('not a heading')));
  const code = outline(['import x from "y";', 'export function trim(a) {', '  return a;', '}', 'class Pruner {', 'const run = async () => {'], 'a.mjs');
  assert.deepEqual(code.map((e) => e.trim().split(':')[0]), ['2', '5', '6']);
});

const event = (dir, command, extra = {}) => ({ session_id: 's1', hook_event_name: 'PreToolUse', cwd: dir, transcript_path: claudeTranscript(dir), tool_name: 'Bash', tool_input: { command }, ...extra });

test('a long read by the orchestrator is turned back once with an outline, then allowed', () => {
  const dir = tmp();
  doc(dir);
  const first = hook('claude', 'pre-tool-use', event(dir, 'cat guide.md'), { dir });
  assert.equal(first.log.decision, 'denied');
  const reason = first.output.hookSpecificOutput.permissionDecisionReason;
  assert.equal(first.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason, /Outline of the whole file \(303 lines\)/);
  assert.match(reason, /## Section 2/);
  const again = hook('claude', 'pre-tool-use', event(dir, 'cat guide.md'), { dir });
  assert.equal(again.output, null);
  assert.equal(again.log.decision, 'repeated');
});

test('short reads, subagent reads, and reads without Jev pass untouched', () => {
  const dir = tmp();
  doc(dir);
  assert.equal(hook('claude', 'pre-tool-use', event(dir, "sed -n '1,40p' guide.md"), { dir }).log.decision, 'below_threshold');
  assert.equal(hook('claude', 'pre-tool-use', event(dir, 'cat guide.md', { agent_id: 'a1' }), { dir }).log.decision, 'subagent');
  assert.equal(hook('claude', 'pre-tool-use', event(dir, 'cat guide.md'), { dir, env: { JEV_CONTEXT_JEV: 'off' } }).log.decision, 'no_jev');
  assert.equal(hook('claude', 'pre-tool-use', event(dir, 'cat guide.md'), { dir, env: { JEV_CONTEXT_READ_GATE_LINES: '500' } }).log.decision, 'below_threshold');
  const read = hook('claude', 'pre-tool-use', { ...event(dir, ''), tool_name: 'Read', tool_input: { file_path: join(dir, 'guide.md') } }, { dir });
  assert.equal(read.log.decision, 'denied');
});

test('without a visible purpose the gate does not ask Jev and lets the read through', () => {
  const dir = tmp();
  doc(dir);
  const quiet = { ...event(dir, 'cat guide.md'), transcript_path: claudeTranscript(dir, { silentTurns: 6, finalText: '' }) };
  const { output, log } = hook('claude', 'pre-tool-use', quiet, { dir });
  assert.equal(output, null);
  assert.equal(log.decision, 'no_intent');
  const narrated = { ...quiet, transcript_path: claudeTranscript(dir, { silentTurns: 6, finalText: 'Now I need the retry settings, so I will look for them in the guide.' }) };
  assert.equal(hook('claude', 'pre-tool-use', narrated, { dir }).log.decision, 'denied');
  assert.equal(hook('claude', 'pre-tool-use', quiet, { dir, env: { JEV_CONTEXT_READ_GATE_INTENT: 'off' } }).log.decision, 'repeated');
});
