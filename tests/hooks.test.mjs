import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reduceOutput } from '../src/core/reduce.mjs';
import { claudeTranscript, hook, labeledLog, neutralLog, root, tmp } from './helpers.mjs';

const bash = (dir, command, stdout, extra = {}) => ({
  session_id: 's1', hook_event_name: 'PostToolUse', transcript_path: claudeTranscript(dir), tool_name: 'Bash', tool_use_id: 'toolu_1',
  tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false, ...extra },
});

test('claude: a noisy inline output is folded into a Bash output object, original archived', () => {
  const dir = tmp();
  const { output, log } = hook('claude', 'post-tool-use', bash(dir, 'npm run build', neutralLog(300, 100, 200)), { dir, env: { JEV_CONTEXT_JEV: 'off' } });
  const replaced = output.hookSpecificOutput.updatedToolOutput;
  assert.equal(log.decision, 'fold');
  assert.equal(typeof replaced, 'object');
  const archive = replaced.stdout.match(/full output: (\S+)\]/)[1];
  assert.equal(readFileSync(archive, 'utf8'), neutralLog(300, 100, 200));
  assert.match(replaced.stdout, /sha256:7e4c9a/);
});

test('claude: an output the host saved is pruned within its preview budget, never above it', () => {
  const dir = tmp();
  const saved = join(dir, 'tool-results-b1.txt');
  writeFileSync(saved, labeledLog());
  const { output, log } = hook('claude', 'post-tool-use', bash(dir, 'npm run build', labeledLog().slice(0, 30_000), { persistedOutputPath: saved, persistedOutputSize: labeledLog().length }), { dir });
  const replaced = output.hookSpecificOutput.updatedToolOutput;
  assert.ok(replaced.stdout.length <= saved.length + 2_100);
  assert.equal(replaced.persistedOutputPath, undefined);
  assert.ok(['fold', 'jev'].includes(log.decision));
});

test('claude: reading a file through Bash is left exactly as it is', () => {
  const dir = tmp();
  const { output, log } = hook('claude', 'post-tool-use', bash(dir, 'cat build.log', labeledLog().slice(0, 20_000)), { dir });
  assert.equal(output, null);
  assert.equal(log.decision, 'document');
});

function agentTranscript(dir, texts) {
  const path = join(dir, 'subagents', 'agent-a1.jsonl');
  mkdirSync(join(dir, 'subagents'), { recursive: true });
  const lines = [{ type: 'user', message: { role: 'user', content: 'Survey the HTTP status codes.' } },
    { type: 'assistant', message: { id: 'x1', role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'data' }] } },
    ...texts.map((text, i) => ({ type: 'assistant', message: { id: `y${i}`, role: 'assistant', content: [{ type: 'text', text }] } }))];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
}

test('report: an over-budget report is saved by the hook and the subagent is sent back once', () => {
  const dir = tmp();
  const report = ['Part one. '.repeat(250), 'Part two. '.repeat(150)];
  const event = { session_id: 's1', hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: agentTranscript(dir, report), last_assistant_message: report[1], stop_hook_active: false };
  assert.equal(hook('claude', 'subagent-stop', { ...event, agent_type: '' }, { dir }).log.decision, 'internal_agent');
  const { output, log } = hook('claude', 'subagent-stop', event, { dir });
  assert.equal(output.decision, 'block');
  assert.equal(log.reportChars, report.join('\n\n').length);
  assert.equal(readFileSync(log.archive, 'utf8'), report.join('\n\n'));
  assert.ok(output.reason.includes(log.archive));
  assert.equal(hook('claude', 'subagent-stop', { ...event, stop_hook_active: true }, { dir }).output, null);
  const small = hook('claude', 'subagent-stop', { ...event, agent_transcript_path: agentTranscript(tmp(), ['short']), last_assistant_message: 'short' }, { dir });
  assert.equal(small.log.decision, 'within_budget');
});

test('report: an over-budget SubagentHandback is denied once, the report archived by the hook', () => {
  const dir = tmp();
  const event = { session_id: 's1', hook_event_name: 'PreToolUse', agent_id: 'a9', tool_name: 'SubagentHandback', tool_input: { message: 'Finding. '.repeat(700) }, transcript_path: join(dir, 's1.jsonl') };
  const first = hook('claude', 'pre-tool-use', event, { dir });
  assert.equal(first.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(readFileSync(first.log.archive, 'utf8'), event.tool_input.message);
  assert.match(first.output.hookSpecificOutput.permissionDecisionReason, /Call SubagentHandback again with a "## Summary" section of at most 1500 characters/);
  assert.equal(hook('claude', 'pre-tool-use', event, { dir }).output, null);
  assert.equal(hook('claude', 'pre-tool-use', { ...event, agent_id: 'a10', tool_input: { message: 'short' } }, { dir }).log.decision, 'within_budget');
});

test('report: every spawned worker is asked once for a Summary/Details report; only it sees the request', () => {
  const dir = tmp();
  const spawn = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'survey', prompt: 'Survey the repo.' } };
  const guided = hook('claude', 'pre-tool-use', spawn, { dir });
  const prompt = guided.output.hookSpecificOutput.updatedInput.prompt;
  assert.equal(guided.output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(prompt, /^Survey the repo\.\n\n\[jev-context report format\] Start your final report with a "## Summary" section of at most 1500 characters/);
  assert.equal(hook('claude', 'pre-tool-use', { ...spawn, tool_input: { prompt } }, { dir }).output, null);
  assert.equal(hook('claude', 'pre-tool-use', spawn, { dir, env: { JEV_CONTEXT_REPORT_SPLIT: 'off' } }).output, null);
});

test('report: a Summary/Details hand-back delivers the Summary and the path, full report saved', () => {
  const dir = tmp();
  const report = `## Summary\nAll four fixes are in (commits a1b2c3d, e4f5a6b); tests pass.\n\n## Details\n${'Line of detail. '.repeat(300)}`;
  const event = { session_id: 's1', hook_event_name: 'PreToolUse', agent_id: 'w1', agent_type: 'general-purpose', tool_name: 'SubagentHandback', tool_input: { message: report }, transcript_path: join(dir, 's1.jsonl') };
  const { output, log } = hook('claude', 'pre-tool-use', event, { dir });
  const delivered = output.hookSpecificOutput.updatedInput.message;
  assert.equal(log.decision, 'split');
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(delivered, /^## Summary\nAll four fixes are in/);
  assert.ok(!delivered.includes('Line of detail'));
  assert.equal(readFileSync(log.archive, 'utf8'), report);
  assert.ok(delivered.includes(log.archive));
  // A long report without the shape is still sent back once.
  const flat = hook('claude', 'pre-tool-use', { ...event, agent_id: 'w2', tool_input: { message: 'Finding. '.repeat(700) } }, { dir });
  assert.equal(flat.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(flat.output.hookSpecificOutput.permissionDecisionReason, /## Summary/);
});

test('report: "SubagentHandback is not available" does not count as hand-back mode', () => {
  const dir = tmp();
  const path = agentTranscript(dir, ['Part one. '.repeat(400)]);
  writeFileSync(path, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'SubagentHandback is not available in this run.' } })}\n${readFileSync(path, 'utf8')}`);
  const { log } = hook('claude', 'subagent-stop', { session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: path, last_assistant_message: 'x', stop_hook_active: false }, { dir });
  assert.equal(log.decision, 'asked_to_shorten');
});

test('report: SubagentStop stays out of the way once a subagent has handed back', () => {
  const dir = tmp();
  const path = agentTranscript(dir, ['Part one. '.repeat(400)]);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n${JSON.stringify({ type: 'assistant', message: { id: 'h', role: 'assistant', content: [{ type: 'tool_use', id: 'hb', name: 'SubagentHandback', input: { message: 'done' } }] } })}`);
  const { output, log } = hook('claude', 'subagent-stop', { session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: path, last_assistant_message: 'x', stop_hook_active: false }, { dir });
  assert.equal(output, null);
  assert.equal(log.decision, 'handback_mode');
});

test('retain: PreCompact keeps exact values and SessionStart(compact) appends them once', () => {
  const dir = tmp();
  const transcript = claudeTranscript(dir, { results: [['find . -name tmp', 'tmp/a\ntmp/b'], ['npm run build', neutralLog()]] });
  const pre = hook('claude', 'pre-compact', { session_id: 's1', hook_event_name: 'PreCompact', trigger: 'manual', transcript_path: transcript }, { dir });
  assert.equal(pre.log.decision, 'selected');
  assert.equal(pre.log.picker, 'rules+carry');
  assert.equal(pre.log.carryAsked, 1, 'only the large output is asked about');
  assert.equal(pre.log.jevRequests, 1, 'one request per compaction');
  assert.equal(pre.log.carried, 0);
  // Rules only: no request at all.
  const rulesDir = tmp();
  const rulesTranscript = claudeTranscript(rulesDir, { results: [['npm run build', neutralLog()]] });
  const rules = hook('claude', 'pre-compact', { session_id: 's1', trigger: 'manual', transcript_path: rulesTranscript }, { dir: rulesDir, env: { JEV_CONTEXT_RETAIN: 'rules' } });
  assert.equal(rules.log.picker, 'rules');
  assert.equal(rules.log.jevRequests, undefined);
  const start = { session_id: 's1', hook_event_name: 'SessionStart', source: 'compact' };
  const injected = hook('claude', 'session-start', start, { dir });
  const text = injected.output.hookSpecificOutput.additionalContext;
  assert.match(text, /sha256:7e4c9a[\s\S]*stable-snapshot[\s\S]*Build completed/);
  assert.ok(text.length < 600, `${text.length} chars`);
  assert.equal(hook('claude', 'session-start', start, { dir }).output, null);
  // The Jev picker is still there when asked for.
  const jevDir = tmp();
  const labeled = claudeTranscript(jevDir, { results: [['npm run build', labeledLog()]] });
  const viaJev = hook('claude', 'pre-compact', { session_id: 's1', trigger: 'manual', transcript_path: labeled }, { dir: jevDir, env: { JEV_CONTEXT_RETAIN: 'jev' } });
  assert.equal(viaJev.log.picker, 'jev');
  assert.ok(viaJev.log.jevRequests >= 1);
  const hybridDir = tmp();
  const hybridTranscript = claudeTranscript(hybridDir, { results: [['npm run build', neutralLog(120, 50, 80)], ['node policy.mjs', 'release policy decision: preserve the legacy wire format']] });
  const hybrid = hook('claude', 'pre-compact', { session_id: 's1', trigger: 'manual', transcript_path: hybridTranscript }, { dir: hybridDir, env: { JEV_CONTEXT_RETAIN: 'hybrid' } });
  assert.equal(hybrid.log.picker, 'hybrid');
  assert.ok(hybrid.log.ruleFacts > 0);
  assert.ok(hybrid.log.semanticFacts > 0);
});

test('retain: the same pair works on a Codex rollout', () => {
  const dir = tmp();
  const rollout = join(dir, 'rollout.jsonl');
  const item = (payload) => JSON.stringify({ type: 'response_item', payload });
  writeFileSync(rollout, [
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build it and keep the digest.' }] }),
    item({ type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.exec_command({"cmd":"npm run build"})' }),
    // Codex 0.158's exec envelope around the wrapped (already folded) build output.
    item({ type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: `Script completed\nWall time 0.2 seconds\nOutput:\n${JSON.stringify({ chunk_id: '928a14', exit_code: 0, output: reduceOutput(neutralLog()).text })}` }] }),
  ].join('\n'));
  assert.equal(hook('codex', 'pre-compact', { session_id: 'c1', trigger: 'auto', transcript_path: rollout }, { dir }).log.decision, 'selected');
  const injected = hook('codex', 'session-start', { session_id: 'c1', source: 'compact' }, { dir });
  assert.match(injected.output.hookSpecificOutput.additionalContext, /exec npm run build[\s\S]*sha256:7e4c9a[\s\S]*stable-snapshot/);
  assert.doesNotMatch(injected.output.hookSpecificOutput.additionalContext, /chunk_id|similar lines/);
});

test('codex: wrapping is opt-in, limited to noisy commands, and approves only what it wraps', () => {
  const dir = tmp();
  const event = (command) => ({ session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, transcript_path: '/r.jsonl' });
  assert.equal(hook('codex', 'pre-tool-use', event('npm test'), { dir }).output, null);
  const on = { dir, env: { JEV_CONTEXT_CODEX_WRAP: 'on' } };
  assert.equal(hook('codex', 'pre-tool-use', event('ls -la'), on).output, null);
  const wrapped = hook('codex', 'pre-tool-use', event('npm test -- --verbose'), on).output.hookSpecificOutput;
  assert.equal(wrapped.permissionDecision, 'allow');
  assert.match(wrapped.updatedInput.command, /codex-run\.mjs" --b64 /);
  for (const command of ['npm test && echo next', 'npm test; echo next', 'npm test | tee out.log', 'npm test > out.log', 'npm test\necho next', 'FOO=$(whoami) npm test']) {
    const blocked = hook('codex', 'pre-tool-use', event(command), on);
    assert.equal(blocked.output, null, command);
    assert.equal(blocked.log.decision, 'unsafe_shell_syntax');
    assert.equal(blocked.log.readGate, 'not_a_sized_read');
  }
});

test('codex runner: same exit code and stderr, pruned stdout, original archived', () => {
  const dir = tmp();
  const script = join(dir, 'noisy.sh');
  writeFileSync(script, `cat <<'EOF'\n${neutralLog(300, 100, 200)}EOF\necho "warning: done" >&2\nexit 3\n`);
  chmodSync(script, 0o755);
  const run = spawnSync('node', [join(root, 'bin/codex-run.mjs'), '--b64', Buffer.from(`npm run build >/dev/null 2>&1; ${script}`).toString('base64')], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, JEV_CONTEXT_LOG: join(dir, 'log.jsonl'), JEV_CONTEXT_JEV: 'off' },
  });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /warning: done/);
  assert.match(run.stdout, /\[… \d+ similar lines …\]/);
  const archive = run.stdout.match(/full output: (\S+)\]/)[1];
  assert.ok(existsSync(archive));
});

test('codex: a forked session reads the history it inherits from its parent rollout', async () => {
  const { conversation } = await import('../src/transcript/codex.mjs');
  const day = join(tmp(), 'sessions/2026/09/29');
  mkdirSync(day, { recursive: true });
  const parentId = '01a0eccf-8bd2-7a11-a1af-b7ec297c4752';
  const forkId = '01a0eccf-e302-7753-951c-6bd823b35d7e';
  const line = (ordinal, type, payload) => JSON.stringify({ ordinal, type, payload });
  const item = (ordinal, payload) => line(ordinal, 'response_item', payload);
  writeFileSync(join(day, `rollout-2026-09-29T19-56-59-${parentId}.jsonl`), [
    line(0, 'session_meta', { id: parentId }),
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read settle.ts; we fix the guard next.' }] }),
    item(2, { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.exec_command({"cmd":"cat src/ledger/settle.ts"})' }),
    item(3, { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: `Script completed\nWall time 0.1 seconds\nOutput:\n${JSON.stringify({ exit_code: 0, output: 'const a = 1;\nif (guard) return;\n' })}` }] }),
    item(4, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after the fork point' }] }),
  ].join('\n'));
  const fork = join(day, `rollout-2026-09-29T19-57-22-${forkId}.jsonl`);
  writeFileSync(fork, [
    line(4, 'session_meta', { id: forkId, forked_from_id: parentId, history_base: { thread_id: parentId, end_ordinal_exclusive: 4 } }),
    item(5, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now quote the guard.' }] }),
  ].join('\n'));
  const { messages, results } = conversation(fork);
  assert.equal(results.length, 1, 'the parent tool output is part of the fork');
  assert.match(results[0].text, /if \(guard\) return;/);
  assert.deepEqual(messages.filter((m) => m.role === 'user' && m.text).map((m) => m.text), ['Read settle.ts; we fix the guard next.', 'Now quote the guard.']);
});
