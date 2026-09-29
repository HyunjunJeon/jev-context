// A/B of the read gate on real repository files: the same task in a fresh
// `claude -p` session with the gate off and on, live Jev. Measures what the
// main context took in (tool results + denials), round trips, cost and whether
// the answer still has the facts the task asks for.
//   node scripts/ab-readgate.mjs [reps]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const reps = Number(process.argv[2] ?? 1);
const model = process.env.E2E_MODEL ?? 'sonnet';
// Where each file sits in the scratch copy (the paths the prompts use) and
// where it comes from. The two seminar documents are snapshots kept as
// fixtures (2026-09-29), since the originals may change or go; README.md is
// the current one, so `readme-sections` checks today's section names.
const FILES = [
  ['2026-09/시연-3종-심층-가이드.md', 'scripts/fixtures/readgate/시연-3종-심층-가이드.md'],
  ['2026-09/jev-loop-cases.md', 'scripts/fixtures/readgate/jev-loop-cases.md'],
  ['2026-09/jev-context/README.md', 'README.md'],
  ['2026-09/jev-context/vendor/jev-pruner/src', 'vendor/jev-pruner/src'],
];
const TASKS = [
  { id: 'router-branches', prompt: '2026-09/시연-3종-심층-가이드.md 에서 Jev-Router 정책의 "네 갈림길"이 무엇인지 알려줘.', expect: [/0\.3/, /20,?000|2만|20k/i, /use opus|명시/i, /시간 ?초과|timeout|실패/i] },
  { id: 'protected-lines', prompt: '2026-09/jev-context/vendor/jev-pruner/src 코드에서, Jev 점수와 관계없이 항상 보존되는 줄이 어떤 규칙으로 정해지는지 알려줘.', expect: [/isProtectedLine/, /first|last|첫|마지막|경계/i] },
  { id: 'case-six', prompt: '2026-09/jev-loop-cases.md 의 "루프 위치별 사례" 중 6번 사례의 제목과 핵심 내용을 알려줘.', expect: [/AGENTS\.md/] },
  { id: 'readme-sections', prompt: '2026-09/jev-context/README.md 의 각 섹션(## 제목)을 빠짐없이 한 줄씩 요약해줘.', expect: [/report/i, /retain/i, /설치|install/i, /한계|limit/i, /설정|config/i] },
];

const work = mkdtempSync(join(tmpdir(), 'jev-readgate-ab-'));
for (const [to, from] of FILES) {
  mkdirSync(dirname(join(work, to)), { recursive: true });
  cpSync(join(root, from), join(work, to), { recursive: true });
}

function run(task, gate, rep) {
  const log = join(work, `decisions-${task.id}-${gate}-${rep}.jsonl`);
  const tools = ['Read', 'Grep', 'Glob', 'Bash(cat:*)', 'Bash(sed:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(grep:*)', 'Bash(nl:*)', 'Bash(wc:*)', 'Bash(ls:*)'];
  const started = Date.now();
  const r = spawnSync('claude', ['-p', task.prompt, '--model', model, '--plugin-dir', root, '--allowedTools', ...tools, '--output-format', 'stream-json', '--verbose'], {
    cwd: work, input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000,
    env: { ...process.env, JEV_CONTEXT_READ_GATE: gate, JEV_CONTEXT_LOG: log, JEV_CONTEXT_STATE_DIR: join(work, `state-${task.id}-${gate}-${rep}`) },
  });
  const events = r.stdout.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((e) => !e.parent_tool_use_id);
  const results = events.filter((e) => e.type === 'user').flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : [])).filter((b) => b.type === 'tool_result')
    .map((b) => (typeof b.content === 'string' ? b.content : b.content.map((c) => c.text ?? '').join('')));
  const calls = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'tool_use');
  const text = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const result = events.find((e) => e.type === 'result');
  const gateLog = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((d) => d.hook === 'pre-tool-use' && d.lines) : [];
  const lastUsage = events.filter((e) => e.type === 'assistant' && e.message.usage).at(-1)?.message.usage;
  return {
    task: task.id, gate, rep,
    resultChars: results.reduce((s, t) => s + t.length, 0),
    calls: calls.length,
    denied: gateLog.filter((d) => d.decision === 'denied').length,
    gateDecisions: gateLog.map((d) => `${d.decision}${d.p !== undefined ? `(p=${d.p})` : ''}:${d.lines}`),
    finalContext: lastUsage ? lastUsage.input_tokens + lastUsage.cache_read_input_tokens + lastUsage.cache_creation_input_tokens : null,
    correct: task.expect.every((re) => re.test(text)),
    cost: result?.total_cost_usd, seconds: Math.round((Date.now() - started) / 1000),
  };
}

const rows = [];
for (let rep = 1; rep <= reps; rep += 1) for (const task of TASKS) for (const gate of ['off', 'on']) {
  const row = run(task, gate, rep);
  rows.push(row);
  console.error(JSON.stringify(row));
}
console.log('\ntask              gate  tool-result chars  final ctx  calls  denied  correct   cost    s   gate decisions');
for (const r of rows) console.log(`${r.task.padEnd(17)} ${r.gate.padEnd(4)} ${String(r.resultChars).padStart(12)} ${String(r.finalContext).padStart(12)} ${String(r.calls).padStart(6)} ${String(r.denied).padStart(7)} ${String(r.correct).padStart(8)} ${(r.cost ?? 0).toFixed(3).padStart(7)} ${String(r.seconds).padStart(4)}   ${r.gateDecisions.join(', ')}`);
const sum = (gate, f) => rows.filter((r) => r.gate === gate).reduce((s, r) => s + (f(r) ?? 0), 0);
for (const gate of ['off', 'on']) console.log(`TOTAL ${gate}: tool-result chars ${sum(gate, (r) => r.resultChars)}, final ctx ${sum(gate, (r) => r.finalContext)}, calls ${sum(gate, (r) => r.calls)}, correct ${rows.filter((r) => r.gate === gate && r.correct).length}/${rows.filter((r) => r.gate === gate).length}, cost $${sum(gate, (r) => r.cost).toFixed(3)}`);
