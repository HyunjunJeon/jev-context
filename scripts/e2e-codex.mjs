// End-to-end check with real `codex exec` sessions. The plugin's codex/hooks.json
// is installed as a project hooks file in a scratch directory (the user's
// ~/.codex is not touched) and run with --dangerously-bypass-hook-trust.
// Scene 1 wraps `npm run build` (JEV_CONTEXT_CODEX_WRAP=on); scene 2 forces an
// auto compaction with a tiny model_auto_compact_token_limit.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'jev-context-codex-'));
const jev = process.env.TYPESAFE_API_KEY ? 'live' : 'simulated';
const logFile = join(work, 'decisions.jsonl');

mkdirSync(join(work, '.codex'));
writeFileSync(join(work, '.codex/hooks.json'), readFileSync(join(root, 'codex/hooks.json'), 'utf8').replaceAll('${PLUGIN_ROOT}', root));
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'e2e', private: true, scripts: { build: 'node noisy.mjs' } }));
writeFileSync(join(work, 'noisy.mjs'), `
const mods = ['audit', 'fx', 'ledger', 'payout', 'refund', 'invoice', 'kyc', 'settle'];
const out = ['> seminar-bundle@4.18.2 build'];
for (let i = 1; i <= 1800; i += 1) {
  out.push('[bundle] chunk ' + String(i).padStart(4, '0') + ' ' + mods[i % 8] + '-' + ((i * 2654435761) >>> 0).toString(16).slice(0, 6) + '.js reused from incremental cache (' + ((i % 29) + 2) + ' kB)');
  if (i === 900) out.push('[release] bundle Q7 digest sha256:7e4c9a');
  if (i === 1200) out.push('[release] rollback target stable-snapshot');
}
out.push('Build completed: 1 bundle, 0 errors');
console.log(out.join('\\n'));
`);

function codex(prompt, { resume, config = [] } = {}) {
  const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', process.env.E2E_CODEX_SANDBOX ?? 'workspace-write', '--json', ...config.flatMap((c) => ['-c', c])];
  if (resume) args.push('resume', resume);
  args.push(prompt);
  const run = spawnSync('codex', args, {
    cwd: work, input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 400_000,
    env: { ...process.env, JEV_CONTEXT_JEV: jev, JEV_CONTEXT_LOG: logFile, JEV_CONTEXT_STATE_DIR: join(work, 'state'), JEV_CONTEXT_CODEX_WRAP: 'on' },
  });
  const events = run.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
  return {
    thread: events.find((e) => e.type === 'thread.started')?.thread_id ?? resume,
    commands: items.filter((i) => i.type === 'command_execution').map((i) => ({ command: i.command?.slice(0, 120), outputChars: i.aggregated_output?.length, exit: i.exit_code, values: /7e4c9a/.test(i.aggregated_output ?? '') })),
    text: items.filter((i) => i.type === 'agent_message').map((i) => i.text).join(' '),
    usage: events.filter((e) => e.type === 'turn.completed').map((e) => e.usage),
    exit: run.status,
  };
}

const decisions = (hook) => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((d) => d.hook === hook) : []);
const report = { jev, work, scenes: {} };

const s1 = codex('Run `npm run build` exactly once, with no pipes and no other commands. Then report the bundle Q7 digest and the rollback target exactly as printed.');
report.scenes.prune = {
  wrap: decisions('pre-tool-use').map((d) => d.decision),
  runner: decisions('codex-run').map((d) => ({ decision: d.decision, source: d.sourceChars, visible: d.visibleChars, exit: d.exitCode })),
  commands: s1.commands,
  answerHasValues: /7e4c9a/.test(s1.text) && /stable-snapshot/.test(s1.text),
  answer: s1.text.slice(-240),
};

const s2 = codex('Without running any command, state the bundle Q7 digest and the rollback target exactly.', { resume: s1.thread, config: ['model_auto_compact_token_limit=4000'] });
const rollout = spawnSync('bash', ['-lc', `ls -t ~/.codex/sessions/*/*/*/rollout-*${s1.thread}.jsonl | head -1`], { encoding: 'utf8' }).stdout.trim();
const compactions = rollout ? readFileSync(rollout, 'utf8').split('\n').filter((l) => /"type":"compacted"|context_compacted/.test(l)).length : null;
report.scenes.retain = {
  preCompact: decisions('pre-compact').map((d) => ({ decision: d.decision, picker: d.picker, trigger: d.trigger, results: d.results, facts: d.facts, chars: d.chars, jevRequests: d.jevRequests })),
  sessionStart: decisions('session-start').map((d) => d.decision),
  compactionsInRollout: compactions,
  answerHasValues: /7e4c9a/.test(s2.text) && /stable-snapshot/.test(s2.text),
  answer: s2.text.slice(-240),
  exit: s2.exit,
};
console.log(JSON.stringify(report, null, 2));
