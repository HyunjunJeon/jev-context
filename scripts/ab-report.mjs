// A/B of the Summary/Details report split on real repository files: the same
// delegation task with the split off and on. Measures what reached the
// coordinator (hand-back size), whether it went back to the saved details,
// correctness, context and cost.   node scripts/ab-report.mjs [reps]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const reps = Number(process.argv[2] ?? 1);
const model = process.env.E2E_MODEL ?? 'sonnet';
const work = mkdtempSync(join(tmpdir(), 'jev-report-ab-'));
mkdirSync(join(work, 'jev-context'));
cpSync(join(root, 'src'), join(work, 'jev-context/src'), { recursive: true });
cpSync(join(root, 'README.md'), join(work, 'jev-context/README.md'));

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const limits = readme.split('## 한계와 주의')[1]?.split('\n## ')[0] ?? '';
const bullets = limits.split('\n').filter((l) => /^- /.test(l)).length;

const TASKS = [
  { id: 'survey-then-detail', prompt: 'Agent 도구로 서브에이전트 하나에게 `jev-context/src` 아래 모든 파일의 역할과 export 함수 목록을 조사하게 해. 보고를 받으면, prune 단계에서 Jev를 부를지 말지를 정하는 조건이 어느 파일의 어떤 변수(또는 설정값)로 정해지는지 정확히 알려줘.', expect: [/prune\.mjs/, /foldFits|pruneJev|PRUNE_JEV/] },
  { id: 'conclusion-only', prompt: `Agent 도구로 서브에이전트 하나에게 \`jev-context/README.md\`에 "## 한계와 주의" 절이 있는지, 그 절의 맨 앞 글머리표(- 로 시작하는 줄) 개수가 몇 개인지 확인하게 해. 보고를 받으면 "있음/없음, N개"만 한 줄로 답해.`, expect: [new RegExp(`${bullets}\\s*개`)] },
  { id: 'review-then-decide', prompt: 'Agent 도구로 서브에이전트 하나에게 `jev-context/src/core/readgate.mjs`의 잠재적 버그와 약점을 빠짐없이 찾아 보고하게 해. 보고를 받으면 가장 먼저 고칠 하나를 골라 이유와 함께 설명해.', expect: [/readRequest|outline|sizeRequest|assessRead|denyMessage|readToolRequest/] },
];

function run(task, arm, rep) {
  const log = join(work, `decisions-${task.id}-${arm}-${rep}.jsonl`);
  const env = { ...process.env, JEV_CONTEXT_LOG: log, JEV_CONTEXT_STATE_DIR: join(work, `state-${task.id}-${arm}-${rep}`) };
  if (arm === 'off') Object.assign(env, { JEV_CONTEXT_REPORT_SPLIT: 'off', JEV_CONTEXT_REPORT_MAX_CHARS: '100000000' });
  const budget = arm.match(/^on@(\d+)$/);
  if (budget) env.JEV_CONTEXT_REPORT_SUMMARY_CHARS = budget[1];
  const tools = ['Agent', 'Read', 'Grep', 'Glob', 'Bash(cat:*)', 'Bash(sed:*)', 'Bash(grep:*)', 'Bash(head:*)', 'Bash(ls:*)', 'Bash(wc:*)'];
  const started = Date.now();
  const r = spawnSync('claude', ['-p', task.prompt, '--model', model, '--plugin-dir', root, '--add-dir', join(homedir(), '.claude/projects'), '--allowedTools', ...tools, '--output-format', 'stream-json', '--verbose'], {
    cwd: work, input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000, env,
  });
  const events = r.stdout.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const main = events.filter((e) => !e.parent_tool_use_id);
  const session = events.find((e) => e.type === 'result')?.session_id;
  const text = main.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const reads = main.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'tool_use' && /report-\d+\.md/.test(JSON.stringify(b.input))).length;
  // What reached the coordinator: hand-back messages in its transcript.
  let delivered = 0;
  const proj = join(homedir(), '.claude/projects', work.replace(/[/_]/g, '-'));
  const transcript = session && join(proj, `${session}.jsonl`);
  if (transcript && existsSync(transcript)) {
    for (const line of readFileSync(transcript, 'utf8').split('\n')) {
      try {
        // A hand-back arrives as a queued attachment or as a user message; a
        // task notification carries the report in <result>.
        const e = JSON.parse(line);
        if (e.isSidechain) continue;
        const a = e.attachment;
        const c = e.message?.content;
        if (a?.type === 'queued_command' && String(a.prompt).includes('<agent-message')) delivered += String(a.prompt).length;
        if (e.type === 'user' && typeof c === 'string' && c.includes('<agent-message')) delivered += c.length;
        else if (e.type === 'user' && typeof c === 'string' && c.includes('<task-notification>')) delivered += (c.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? '').length;
      } catch { /* partial line */ }
    }
  }
  const decisions = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((d) => d.hook === 'pre-tool-use' && ['split', 'guided', 'asked_to_shorten', 'within_budget'].includes(d.decision)).map((d) => d.decision) : [];
  const usage = main.filter((e) => e.type === 'assistant' && e.message.usage).at(-1)?.message.usage;
  const result = events.find((e) => e.type === 'result');
  return {
    task: task.id, arm, rep, delivered, readsOfDetails: reads, decisions: [...new Set(decisions)].join('+'),
    finalContext: usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : null,
    correct: task.expect.every((re) => re.test(text)), cost: result?.total_cost_usd ?? 0, seconds: Math.round((Date.now() - started) / 1000),
  };
}

const rows = [];
const ARMS = (process.env.AB_ARMS ?? 'off,on').split(',');
for (let rep = 1; rep <= reps; rep += 1) for (const task of TASKS) for (const arm of ARMS) {
  const row = run(task, arm, rep);
  rows.push(row);
  console.error(JSON.stringify(row));
}
console.log(`expected bullet count: ${bullets}`);
console.log('task                 arm      delivered  details-reads  final ctx  correct   cost    s   hook decisions');
for (const r of rows) console.log(`${r.task.padEnd(20)} ${r.arm.padEnd(8)} ${String(r.delivered).padStart(9)} ${String(r.readsOfDetails).padStart(14)} ${String(r.finalContext).padStart(10)} ${String(r.correct).padStart(8)} ${r.cost.toFixed(3).padStart(7)} ${String(r.seconds).padStart(4)}   ${r.decisions}`);
for (const arm of ARMS) {
  const g = rows.filter((r) => r.arm === arm);
  console.log(`TOTAL ${arm}: delivered ${g.reduce((s, r) => s + r.delivered, 0)}, details reads ${g.reduce((s, r) => s + r.readsOfDetails, 0)}, final ctx ${g.reduce((s, r) => s + (r.finalContext ?? 0), 0)}, correct ${g.filter((r) => r.correct).length}/${g.length}, cost $${g.reduce((s, r) => s + r.cost, 0).toFixed(3)}`);
}
