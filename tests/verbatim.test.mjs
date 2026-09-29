import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from '../hooks/verbatim-compact.mjs';
import { reduceOutput, standoutLines } from '../src/core/reduce.mjs';
import { compactVerbatim } from '../src/core/verbatim.mjs';
import { cfgFor, neutralLog, tmp } from './helpers.mjs';

const noise = (label, lines = 120) => Array.from({ length: lines }, (_, i) => `[${label}] chunk ${String(i).padStart(4, '0')} reused from incremental cache (${(i % 29) + 2} kB)`);
const withValue = (label, value, at = 60) => {
  const lines = noise(label);
  lines.splice(at, 0, value);
  return lines.join('\n');
};

// Claude Code's SessionMessage shape, as session.compact hands it over.
function session({ small = false } = {}) {
  const outputs = small
    ? ['ok', 'ok', 'ok', 'ok', 'ok']
    : [
        noise('deps').join('\n'),
        withValue('build', 'BUNDLE Q7 = sha256:7e4c9a1fd20b (pin this hash in the release note)'),
        noise('lint').join('\n'),
        withValue('canary', 'ROLLBACK TOKEN = rbk_11142a3bae0019aa (not recoverable later)'),
        noise('logs').join('\n'),
      ];
  const messages = [{ role: 'user', text: 'Release ledger-api and keep the canary ids for the handoff.', toolUses: [], handle: 'h0' }];
  outputs.forEach((text, i) => {
    const id = `tu${i + 1}`;
    messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `ledger-tool step${i + 1}` }, text, result: { stdout: text } }], handle: `a${i}` });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false, result: { stdout: text } }], handle: `r${i}` });
    messages.push({ role: 'assistant', text: `step ${i + 1} done`, toolUses: [], handle: `s${i}` });
  });
  for (let i = 0; i < 6; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', text: `recent ${i}`, toolUses: [], handle: `n${i}` });
  return messages;
}

function fakeJev({ keepCall = {}, keepResult = {}, closedTopic = {}, fail = false, asked = [] } = {}) {
  const counter = { requests: 0 };
  return {
    counter,
    async ask(state, questions) {
      counter.requests += 1;
      for (const [id, q] of Object.entries(questions)) if (id.startsWith('result_')) assert.match(q.instructions, /edits or rewrites what tool call t\d+ read/);
      if (fail) throw new Error('Jev request failed (500)');
      const answers = {};
      for (const id of Object.keys(questions)) {
        const call = id.match(/^call_(t\d+)$/)?.[1];
        const result = id.match(/^result_(t\d+)$/)?.[1];
        const topic = id.match(/^topic_(e\d+)$/)?.[1];
        asked.push(id);
        if (call) answers[id] = { noul: keepCall[call] ?? 0.9 };
        else if (result) answers[id] = { noul: keepResult[result] ?? 0.1 };
        else if (topic) answers[id] = { noul: closedTopic[topic] ?? 0.1 };
        else throw new Error(`unexpected question ${id}`);
      }
      return { answers };
    },
  };
}

const textOf = (messages, id) => messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === id)?.text;

test('verbatim compaction keeps every text, drops stale output, and keeps the exact lines it held', async () => {
  const messages = session();
  // t4 (the canary) is judged not worth keeping at all; t5 too.
  const r = await compactVerbatim(cfgFor(tmp()), messages, fakeJev({ keepCall: { t4: 0.1, t5: 0.1 } }));
  assert.equal(r.stage, 'compacted');
  assert.ok(r.stats.reduction > 0.5, `reduction ${r.stats.reduction}`);
  // User and assistant text stays verbatim and in order.
  const texts = (list) => list.map((m) => m.text).filter(Boolean);
  assert.deepEqual(texts(r.messages), texts(messages));
  // A dropped result keeps its head and the line with the value.
  const build = textOf(r.messages, 'tu2');
  assert.match(build, /BUNDLE Q7 = sha256:7e4c9a1fd20b/);
  assert.match(build, /^\[build\] chunk 0000 [^\n]*\n\[jev-context: \d+ chars dropped at compaction; standout lines kept/);
  assert.ok(build.length < textOf(messages, 'tu2').length / 5);
  // A call that would have gone whole stays because its output held a value.
  assert.match(textOf(r.messages, 'tu4'), /ROLLBACK TOKEN = rbk_11142a3bae0019aa/);
  assert.equal(r.decisions.find((d) => d.id === 't4').rescued, true);
  // One with nothing needed goes, call and result together.
  assert.equal(textOf(r.messages, 'tu5'), undefined);
  assert.ok(!r.messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'tu5')));
  // Untouched user messages are the engine's own objects. Assistant messages
  // come back rebuilt without a handle, so their thinking stays behind.
  assert.equal(r.messages[0], messages[0]);
  assert.equal(r.messages.at(-2), messages.at(-2));
  assert.ok(r.messages.filter((m) => m.role === 'assistant').every((m) => m.handle === undefined));
  for (const m of r.messages.filter((m) => !messages.includes(m))) {
    assert.equal(m.handle, undefined);
    for (const item of [...m.toolUses, ...(m.toolResults ?? [])]) if (item.text !== textOf(messages, item.tool_use_id)) assert.equal(item.result, undefined);
  }
  assert.equal(r.stats.rescuedResults, 2);
  assert.equal(r.stats.jevRequests, 1, 'Jev answers the call-level pair only');
});

test('recent results the assistant already answered are judged too; an unanswered one and kept inputs stay whole', async () => {
  const long = (label) => noise(label, 200).join('\n');
  const write = 'x'.repeat(5_000);
  const messages = [
    { role: 'user', text: 'Tidy the release notes, then check the flags.', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'Write', input: { file_path: 'NOTES.md', content: write } }], handle: 'a0' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'w1', text: 'File written' }], handle: 'r0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e1', tool: 'Write', input: { file_path: 'KEEP.md', content: write } }], handle: 'a1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e1', text: 'File written' }], handle: 'r1' },
    { role: 'assistant', text: 'Notes tidied.', toolUses: [], handle: 'a2' },
    { role: 'user', text: 'Now the flags.', toolUses: [], handle: 'h1' },
    // Inside the newest six messages, answered: the library would pin it.
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'f1', tool: 'Bash', input: { command: 'ledger-tool flags' } }], handle: 'a3' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'f1', text: long('flags') }], handle: 'r2' },
    { role: 'assistant', text: 'Flags look fine.', toolUses: [], handle: 'a4' },
    // Not answered yet: compaction came mid tool loop.
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'ledger-tool changelog' } }], handle: 'a5' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: long('changelog') }], handle: 'r3' },
  ];
  // t2 (KEEP.md) is kept whole; everything else is judged droppable.
  const r = await compactVerbatim(cfgFor(tmp()), messages, fakeJev({ keepResult: { t2: 0.9 } }));
  const d = (id) => r.decisions.find((x) => x.tool_use_id === id || x.id === id);
  assert.equal(r.stats.unpinnedRecent, 1);
  assert.notEqual(textOf(r.messages, 'f1'), textOf(messages, 'f1'), 'the answered recent result was judged and cut');
  assert.equal(textOf(r.messages, 'c1'), textOf(messages, 'c1'), 'the unanswered one stays whole');
  const inputOf = (id) => r.messages.flatMap((m) => m.toolUses).find((t) => t.tool_use_id === id)?.input;
  assert.match(inputOf('w1').content, /^x{300}\[… 4700 chars of this input dropped at compaction\]$/);
  assert.equal(inputOf('e1').content, write, 'a kept call keeps its input');
  assert.equal(r.stats.inputsCut, 1);
  assert.ok(d('t2'));
});

test('with topics on, an exchange the work does not come back to goes whole and leaves a note', async () => {
  const say = (role, text, handle) => ({ role, text, toolUses: [], handle });
  const messages = [
    say('user', 'Check the ledger release.', 'u0'),
    say('assistant', 'Release rel-0926-c259ad is live.', 'a0'),
    say('user', 'Unrelated: outline a CONTRIBUTING guide in detail.', 'u1'),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'g1', tool: 'Bash', input: { command: 'ls docs' } }], handle: 'a1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'g1', text: withValue('docs', 'DOCS INDEX = sha256:abc123def456') }], handle: 'r1' },
    say('assistant', `Here is a long outline. ${'Section text. '.repeat(200)}`, 'a2'),
    say('user', 'Enough about the guide. Back to code: read settle.ts.', 'u2'),
    say('assistant', 'Reading it.', 'a3'),
    say('user', 'The guard is on line 31; we fix it next.', 'u3'),
    say('assistant', 'Noted.', 'a4'),
    say('user', 'ok', 'u4'),
    say('assistant', 'ok', 'a5'),
  ];
  const asked = [];
  const off = await compactVerbatim(cfgFor(tmp()), messages, fakeJev({ asked }));
  assert.ok(!asked.some((id) => id.startsWith('topic_')), 'no topic questions unless compactTopics is on');
  assert.equal(off.stats.topicsAsked, 0);

  // Moved on from, not closed: it stays.
  const movedOn = await compactVerbatim(cfgFor(tmp(), { compactTopics: 'on' }), messages, fakeJev({ closedTopic: { e2: 0.6 } }));
  assert.equal(movedOn.stats.topicsDropped, 0);
  assert.ok(movedOn.messages.some((m) => m.text.includes('Section text.')));

  // e2 (the guide) is closed. e1 is the first exchange; e3-e5 reach into the newest six messages.
  const r = await compactVerbatim(cfgFor(tmp(), { compactTopics: 'on' }), messages, fakeJev({ closedTopic: { e2: 0.9 } }));
  assert.deepEqual(r.topics.map((t) => t.id), ['e2'], 'not the first exchange, not the newest messages');
  assert.equal(r.stats.topicsDropped, 1);
  assert.ok(!r.messages.some((m) => m.text.includes('CONTRIBUTING guide in detail') && !m.text.startsWith('[jev-context')));
  assert.ok(!r.messages.some((m) => m.text.includes('Section text.')));
  assert.ok(!r.messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'g1')), 'its calls go with it');
  const opener = r.messages.find((m) => m.text.includes('Back to code'));
  assert.match(opener.text, /^\[jev-context: an earlier exchange was dropped at compaction because the user closed its topic\. It opened with: "[^"]*CONTRIBUTING[^"]*"\. Lines that stood out in its tool output:\nDOCS INDEX = sha256:abc123def456\]\n\nEnough about the guide/);
  assert.equal(r.messages[0], messages[0]);
  assert.ok(r.messages.some((m) => m.text.includes('rel-0926-c259ad')), 'the first exchange stays');
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
});

test('Jev is asked only where the answer can change the window', async () => {
  const say = (role, text) => ({ role, text, toolUses: [] });
  const call = (id, command, text) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] },
  ];
  const tail = [say('user', 'next'), say('assistant', 'ok'), say('user', 'and'), say('assistant', 'ok'), say('user', 'more'), say('assistant', 'ok')];
  // Only small results and short exchanges: nothing to ask, no request at all.
  const tiny = [say('user', 'Check status.'), ...call('s1', 'git status', 'clean'), say('assistant', 'Clean.'), say('user', 'Short aside.'), say('assistant', 'Sure.'), ...tail];
  const asked = [];
  const quiet = await compactVerbatim(cfgFor(tmp(), { compactTopics: 'on' }), tiny, fakeJev({ asked }));
  assert.equal(quiet.stage, 'no_candidates');
  assert.deepEqual(asked, []);
  // One large result among small ones: only the large one is asked about.
  const mixed = [say('user', 'Build it.'), ...call('b1', 'npm run build', noise('build').join('\n')), ...call('s2', 'git status', 'clean'), say('assistant', 'Built.'), ...tail];
  const asked2 = [];
  const r = await compactVerbatim(cfgFor(tmp()), mixed, fakeJev({ asked: asked2 }));
  assert.deepEqual(asked2.sort(), ['call_t1', 'result_t1']);
  assert.equal(r.stats.callsAsked, 1);
  assert.equal(r.stats.callsTooSmall, 1);
  assert.equal(r.decisions.find((d) => d.tool_use_id === 's2' || d.id === 't2').reason, 'small');
});

test('standout lines: the value, the failure and the summary of a long log; nothing from code', () => {
  const pass = (i) => `  ✓ ${['fx', 'kyc', 'ledger'][i % 3]}/${['audit', 'refund'][i % 2]}.spec.ts › ${['handles empty input', 'rejects timeouts', 'caches large batch'][i % 3]} #${String(i).padStart(4, '0')} (${i % 40}ms)`;
  const log = ['vitest run', ...Array.from({ length: 300 }, (_, i) => pass(i))];
  log.splice(150, 0, '  ✗ ledger/settle.spec.ts › settles idempotent retries once (1204ms)', '    Reproduce with: vitest run ledger/settle.spec.ts --seed 48213');
  log.push('Tests  1 failed | 299 passed (300)');
  assert.deepEqual(standoutLines(log.join('\n')), [log[150], log[151], log.at(-1)]);
  const code = Array.from({ length: 80 }, (_, i) => (i % 2 ? `  const value${i} = compute(${i}, options.limit);` : `export function step${i}(input) {`)).join('\n');
  assert.deepEqual(standoutLines(`${code}\n  return { ok: true, items: [] };\n  if (!input) throw new TypeError('missing');\n  for (const x of list) yield* x;\n}\n// done\n/* end */`), [], 'code without a few outliers has no standouts');
  assert.deepEqual(standoutLines('a\nb\nc'), [], 'too short to judge');
  // What prune already folded is judged however short it became.
  const folded = reduceOutput(neutralLog()).text;
  assert.ok(folded.split('\n').length < 20);
  const kept = standoutLines(folded);
  assert.ok(kept.some((l) => l.includes('sha256:7e4c9a')) && kept.some((l) => l.includes('stable-snapshot')) && kept.some((l) => l.includes('Build completed')), kept.join('\n'));
  assert.ok(!kept.some((l) => /similar lines/.test(l) || /chunk \d{4}/.test(l)), kept.join('\n'));
});

test('verbatim compaction reports when it would not shrink enough', async () => {
  const asked = [];
  assert.equal((await compactVerbatim(cfgFor(tmp()), session({ small: true }), fakeJev({ asked }))).stage, 'no_candidates');
  assert.deepEqual(asked, [], 'small results: no request');
  // One result worth asking about, but the long texts around it stay: under 25%.
  const messages = session({ small: true });
  messages.splice(1, 0, { role: 'assistant', text: 'x'.repeat(20_000), toolUses: [] }, { role: 'user', text: 'go on', toolUses: [] });
  messages.splice(3, 0,
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'big', tool: 'Bash', input: { command: 'ledger-tool logs' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'big', text: noise('logs', 30).join('\n') }] });
  const r = await compactVerbatim(cfgFor(tmp()), messages, fakeJev());
  assert.equal(r.stage, 'below_min');
  assert.equal(r.stats.callsAsked, 1);
});

function host(env = {}, fetch = async () => ({ status: 500, ok: false, text: 'boom' })) {
  const files = new Map();
  const $ = {
    env: { get: async (name) => env[name] },
    plugin: { root: '/plugin' },
    session: { id: async () => 'sess-1' },
    fs: { exists: async (p) => files.has(p), read: async (p) => files.get(p), write: async (p, t) => void files.set(p, t) },
    ui: { log: () => {} },
    clock: { sleep: () => new Promise(() => {}) },
    http: { fetch },
  };
  let handler;
  register((event, fn) => {
    assert.equal(event, 'session.compact');
    handler = fn;
  });
  const summary = { messages: [{ role: 'user', text: 'built-in summary', toolUses: [] }] };
  let passed = 0;
  const next = async () => ((passed += 1), summary);
  const lines = () => (files.get('/plugin/logs/decisions.jsonl') ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { run: (e) => handler($, e, next), passed: () => passed, summary, lines };
}

test('function hook: the built-in summary by default, verbatim when asked, built-in summary on any failure', async () => {
  const e = { trigger: 'manual', messages: session() };
  const byDefault = host({ TYPESAFE_API_KEY: 'test-key' });
  assert.equal(await byDefault.run(e), byDefault.summary);
  assert.equal(byDefault.lines().length, 0, 'summary mode passes on without a word');
  const noKey = host({ JEV_CONTEXT_COMPACT: 'verbatim' });
  assert.equal(await noKey.run(e), noKey.summary, 'no key: nothing to ask Jev with');
  assert.equal(noKey.lines()[0].decision, 'fallback_no_jev');

  const on = host({ JEV_CONTEXT_COMPACT: 'verbatim', JEV_CONTEXT_JEV: 'simulated' });
  const result = await on.run(e);
  assert.equal(on.passed(), 0);
  assert.ok(result.messages.length > 0 && result.messages.length <= e.messages.length);
  assert.match(textOf(result.messages, 'tu2'), /BUNDLE Q7/);
  const [entry] = on.lines();
  assert.equal(entry.decision, 'compacted');
  assert.equal(entry.session, 'sess-1');
  assert.ok(!JSON.stringify(entry).includes('sha256'), 'the log holds no tool output');

  const failing = host({ JEV_CONTEXT_COMPACT: 'verbatim', JEV_CONTEXT_JEV: 'live', TYPESAFE_API_KEY: 'test-key' });
  assert.equal(await failing.run(e), failing.summary);
  assert.equal(failing.lines()[0].decision, 'fallback_error');
  assert.ok(!JSON.stringify(failing.lines()).includes('test-key'));


  assert.ok((await on.run({ ...e, trigger: 'precompute' })).skip);
  const sub = host({ JEV_CONTEXT_COMPACT: 'verbatim', JEV_CONTEXT_JEV: 'simulated' });
  assert.equal(await sub.run({ ...e, agentId: 'a1' }), sub.summary);
});

test('carry: one request inside the built-in compaction; the output the next step edits goes over whole', async () => {
  const { carryWhole, renderCarried } = await import('../src/core/carry.mjs');
  const file = Array.from({ length: 60 }, (_, i) => `  const leg${i} = await ledger.post(batch[${i % 7}], { timeoutMs: ${700 + ((i * 37) % 900)} });`).join('\n');
  const logs = noise('logs', 200).join('\n');
  const say = (role, text) => ({ role, text, toolUses: [], toolResults: [] });
  const call = (id, command, text) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command } }], toolResults: [] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: text.slice(0, 4000) }] },
  ];
  const messages = [say('user', 'Find the guard.'), ...call('r1', 'cat src/ledger/settle.ts', file), ...call('l1', 'kubectl logs deploy/ledger', logs), ...call('s1', 'git status', 'clean'), say('assistant', 'Line 32.'), say('user', 'Next we fix it.')];
  const results = [{ id: 'r1', tool: 'Bash', command: 'Bash cat src/ledger/settle.ts', text: file }, { id: 'l1', tool: 'Bash', command: 'Bash kubectl logs', text: logs }, { id: 's1', tool: 'Bash', command: 'Bash git status', text: 'clean' }];
  const seen = [];
  const jev = { counter: { requests: 0 }, async ask(state, questions) {
    this.counter.requests += 1;
    seen.push(...Object.values(questions).map((q) => q.instructions));
    return { answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { noul: /settle\.ts/.test(q.instructions) ? 0.8 : 0.1 }])) };
  } };
  const r = await carryWhole({}, { messages, results, jev });
  assert.equal(jev.counter.requests, 1);
  assert.equal(r.asked, 2, 'git status is too small to ask about');
  assert.ok(seen.every((q) => /edits or rewrites what tool call t\d+ read \(Bash /.test(q)));
  assert.deepEqual(r.facts.map((f) => f.command), ['Bash cat src/ledger/settle.ts']);
  assert.equal(r.facts[0].text, file, 'whole, not the clipped copy in messages');
  assert.match(renderCarried(r.facts), /carried over whole[\s\S]*\$ Bash cat src\/ledger\/settle\.ts\n  const leg0/);
  // Over the budget it stays out; nothing large, no request.
  assert.equal((await carryWhole({ retainWholeMaxChars: 100 }, { messages, results, jev })).stage, 'over_budget');
  const small = await carryWhole({}, { messages: [say('user', 'hi'), ...call('s1', 'git status', 'clean')], results: [results[2]], jev });
  assert.equal(small.stage, 'nothing_to_ask');
  assert.equal(jev.counter.requests, 2);
});
