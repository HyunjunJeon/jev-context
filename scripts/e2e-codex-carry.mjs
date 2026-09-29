// Codex: a file read through the shell, one more check, then an automatic
// compaction and a request to quote five lines of the file without reading it
// again. Arms: JEV_CONTEXT_RETAIN=rules (no Jev) and on (the default: Jev is
// asked once, inside the compaction, which outputs the next step works on).
// The first two turns run once; every arm forks that thread (`codex exec fork`,
// Codex 0.158) so all arms start from the same conversation.
//   node scripts/e2e-codex-carry.mjs [arms]   (default rules,on; `on#2` repeats)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BLOCK, GUARD, settleSource } from './fixtures/settle.mjs';

const root = resolve(import.meta.dirname, '..');
const arms = (process.argv[2] ?? 'rules,on').split(',');
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY missing');

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'jev-context-carry-'));
  mkdirSync(join(work, '.codex'));
  writeFileSync(join(work, '.codex/hooks.json'), readFileSync(join(root, 'codex/hooks.json'), 'utf8').replaceAll('${PLUGIN_ROOT}', root));
  mkdirSync(join(work, 'src/ledger'), { recursive: true });
  writeFileSync(join(work, 'src/ledger/settle.ts'), settleSource());
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'e2e', private: true, scripts: { build: 'node noisy.mjs' } }));
  writeFileSync(join(work, 'noisy.mjs'), `
const out = ['> seminar-bundle@4.18.2 build'];
for (let i = 1; i <= 1800; i += 1) out.push('[bundle] chunk ' + String(i).padStart(4, '0') + ' ' + ['fx', 'ledger', 'kyc'][i % 3] + '-' + ((i * 2654435761) >>> 0).toString(16).slice(0, 6) + '.js reused from incremental cache (' + ((i % 29) + 2) + ' kB)');
out.push('Build completed: 1 bundle, 0 errors');
console.log(out.join('\\n'));
`);
  return work;
}

function codex(work, env, prompt, { resume, fork, config = [] } = {}) {
  // Options go before `resume`/`fork`, or Codex rejects the command line.
  const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', process.env.E2E_CODEX_SANDBOX ?? 'danger-full-access', '--json', ...config.flatMap((c) => ['-c', c])];
  if (resume) args.push('resume', resume);
  if (fork) args.push('fork', fork);
  args.push(prompt);
  const run = spawnSync('codex', args, { cwd: work, input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000, env: { ...process.env, ...env } });
  const events = run.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
  return {
    thread: events.find((e) => e.type === 'thread.started')?.thread_id ?? resume,
    commands: items.filter((i) => i.type === 'command_execution').map((i) => i.command?.slice(0, 100)),
    text: items.filter((i) => i.type === 'agent_message').map((i) => i.text).join(' '),
    exit: run.status,
  };
}

const work = setup();
const baseEnv = { JEV_CONTEXT_LOG: join(work, 'base.jsonl'), JEV_CONTEXT_STATE_DIR: join(work, 'state'), JEV_CONTEXT_CODEX_WRAP: 'on' };
const s1 = codex(work, baseEnv, 'Run `npm run build` exactly once, with no pipes. Then run `cat src/ledger/settle.ts` exactly once and tell me which line number holds the idempotency guard that double-charges retries. After one more check we will fix that guard.');
codex(work, baseEnv, 'Run `node noisy.mjs` once more, with no pipes, and confirm in one line that the build still completes.', { resume: s1.thread });
console.log(JSON.stringify({ base: s1.thread, reads: s1.commands.filter((c) => /settle\.ts/.test(c)).length }));

for (const arm of arms) {
  const log = join(work, `${arm.replace('#', '-')}.jsonl`);
  const env = { JEV_CONTEXT_LOG: log, JEV_CONTEXT_STATE_DIR: join(work, `state-${arm.replace('#', '-')}`), JEV_CONTEXT_CODEX_WRAP: 'on', JEV_CONTEXT_RETAIN: arm.split('#')[0] };
  const s3 = codex(work, env, 'That check is done, so now we fix the guard. Without running any command or reading any file, quote the guard line and the two lines before and after it exactly as they appear in the file, then write the fixed five lines.', { fork: s1.thread, config: ['model_auto_compact_token_limit=4000'] });
  const decisions = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const pre = decisions.filter((d) => d.hook === 'pre-compact').map(({ decision, trigger, picker, carry, carryAsked, carried, carryChars, carryScores, facts, chars, jevRequests }) => ({ decision, trigger, picker, carry, carryAsked, carried, carryChars, carryScores, facts, chars, jevRequests }));
  const injected = decisions.filter((d) => d.hook === 'session-start' && d.decision === 'injected').map((d) => d.chars);
  console.log(JSON.stringify({
    arm,
    thread: s3.thread,
    compactions: pre.length,
    preCompact: pre,
    injected,
    answer: { guard: s3.text.includes(GUARD), blockLines: BLOCK.filter((l) => s3.text.includes(l)).length, commandsRun: s3.commands.length },
    exit: s3.exit,
  }));
}
