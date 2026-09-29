// End-to-end check with real `claude -p` sessions, the plugin loaded through
// --plugin-dir (nothing installed). Jev runs live when TYPESAFE_API_KEY is
// set, otherwise on simulated scores (reported as such). Costs a few cents.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'jev-context-e2e-'));
const model = process.env.E2E_MODEL ?? 'sonnet';
const jev = process.env.TYPESAFE_API_KEY ? 'live' : 'simulated';
const logFile = join(work, 'decisions.jsonl');
const EXPIRE_AFTER = 20;

writeFileSync(join(work, 'noisy.mjs'), `
const [count, q7, rb] = process.argv[2] === 'big' ? [1800, 900, 1200] : [260, 100, 200];
const mods = ['audit', 'fx', 'ledger', 'payout', 'refund', 'invoice', 'kyc', 'settle'];
const out = ['> seminar-bundle@4.18.2 build'];
for (let i = 1; i <= count; i += 1) {
  out.push('[bundle] chunk ' + String(i).padStart(4, '0') + ' ' + mods[i % 8] + '-' + ((i * 2654435761) >>> 0).toString(16).slice(0, 6) + '.js reused from incremental cache (' + ((i % 29) + 2) + ' kB)');
  if (i === q7) out.push('[release] bundle Q7 digest sha256:7e4c9a');
  if (i === rb) out.push('[release] rollback target stable-snapshot');
}
out.push('Build completed: 1 bundle, 0 errors');
console.log(out.join('\\n'));
`);

function claude(prompt, { resume, env = {}, tools = 'Bash(node noisy.mjs:*)' } = {}) {
  const args = ['-p', prompt, '--model', model, '--plugin-dir', root, '--allowedTools', ...tools.split(' '), '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', resume);
  const run = spawnSync('claude', args, {
    cwd: work, input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, JEV_CONTEXT_JEV: jev, JEV_CONTEXT_LOG: logFile, JEV_CONTEXT_STATE_DIR: join(work, 'state'), JEV_CONTEXT_COMPACT_MIN_TOKENS: '1000', ...env },
  });
  const events = run.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const main = events.filter((e) => !e.parent_tool_use_id);
  const toolResults = main.filter((e) => e.type === 'user').flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
    .filter((b) => b.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : b.content.map((c) => c.text ?? '').join('')));
  // A subagent's report arrives as a task notification or (2.1.284) an agent-message hand-back.
  // A report arrives as a task notification, a hand-back user message, or a queued attachment.
  const notifications = main.filter((e) => e.type === 'user' && typeof e.message.content === 'string' && /<task-notification>|<agent-message/.test(e.message.content))
    .map((e) => (e.message.content.includes('<agent-message') ? e.message.content : e.message.content.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? ''));
  const text = main.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return {
    session: events.find((e) => e.type === 'result')?.session_id,
    compacted: events.some((e) => e.subtype === 'compact_boundary'),
    toolResults,
    notifications,
    text,
    answer: text.slice(-240),
    cost: events.find((e) => e.type === 'result')?.total_cost_usd,
  };
}

const decisions = (hook) => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((d) => d.hook === hook) : []);
const report = { model, jev, work, scenes: {} };

// 1. prune: a small inline log (folded) and a large one Claude Code saves to a file.
const s1 = claude('Run `node noisy.mjs` and then `node noisy.mjs big`, each once, no pipes, no other commands. Report the bundle Q7 digest and the rollback target exactly as the tool results show them.');
report.scenes.prune = {
  decisions: decisions('post-tool-use').map((d) => ({ decision: d.decision, source: d.sourceChars, visible: d.visibleChars, persisted: d.persisted, jevRequests: d.jevRequests, ms: d.elapsedMs })),
  modelSaw: s1.toolResults.map((t) => t.length),
  valuesVisible: s1.toolResults.map((t) => t.includes('7e4c9a') && t.includes('stable-snapshot')),
  answer: s1.answer,
};

// 2. retain: compact that session; the retain picker (JEV_CONTEXT_RETAIN) picks what survives; then ask without tools.
const compact = claude('/compact', { resume: s1.session });
const after = claude('Without using tools, state the bundle Q7 digest and the rollback target exactly.', { resume: s1.session });
report.scenes.retain = {
  compacted: compact.compacted,
  preCompact: decisions('pre-compact').map((d) => ({ decision: d.decision, picker: d.picker, results: d.results, chunks: d.chunks, facts: d.facts, chars: d.chars, jevRequests: d.jevRequests, ms: d.elapsedMs })),
  injected: decisions('session-start').filter((d) => d.decision === 'injected').map((d) => d.chars),
  answerHasValues: after.text.includes('7e4c9a') && after.text.includes('stable-snapshot'),
  answer: after.answer,
};

// 3. report: a subagent writes a long report; the hook saves it and sends it back once.
const s3 = claude('Use the Agent tool once to start a general-purpose subagent with this task: "Without using any tools, write a reference table of 40 common HTTP status codes, each with a two-sentence explanation, as your final message." When its result arrives, tell me how many characters it was and whether it contains a file path.', { tools: 'Agent' });
report.scenes.report = {
  handback: decisions('pre-tool-use').map((d) => ({ decision: d.decision, reportChars: d.reportChars })),
  subagentStop: decisions('subagent-stop').map((d) => ({ decision: d.decision, reportChars: d.reportChars })),
  archived: [...decisions('pre-tool-use'), ...decisions('subagent-stop')].filter((d) => d.archive).map((d) => existsSync(d.archive)),
  deliveredChars: [...s3.toolResults.filter((t) => !t.startsWith('Async agent launched')), ...s3.notifications].map((t) => t.length),
  answer: s3.answer,
};

// 4. timing: resume after the (shortened) TTL; a headless run compacts first.
const base = claude('Answer in one word: ready?', { tools: 'Bash(true)' });
await sleep((EXPIRE_AFTER + 2) * 1000);
const cold = claude('Answer in one word: still there?', { resume: base.session, tools: 'Bash(true)', env: { JEV_CONTEXT_ASSUME_EXPIRED_AFTER: String(EXPIRE_AFTER) } });
report.scenes.timing = { decisions: decisions('session-start').map((d) => d.decision), compacted: cold.compacted, answer: cold.answer };

report.cost = [s1, compact, after, s3, base, cold].reduce((sum, r) => sum + (r.cost ?? 0), 0).toFixed(3);
console.log(JSON.stringify(report, null, 2));
