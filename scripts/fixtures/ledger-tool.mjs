// Synthetic tool output for the compaction/cache experiment. Every command prints ~22k chars
// of plausible noise; only a few lines matter later. `release` is one-time: its ids are random.
// Copied from context-demo/output/compaction-cache (2026-09-26); the release ids now go to
// LEDGER_TRUTH instead of a file beside the script.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [cmd] = process.argv.slice(2);
let seed = [...(cmd ?? '')].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const pad = (n, w = 4) => String(n).padStart(w, '0');
const mods = ['ledger', 'settle', 'payout', 'fx', 'audit', 'webhook', 'invoice', 'refund', 'kyc', 'report'];

function fill(target, line, marks = {}) {
  const out = [];
  let i = 0;
  while (out.join('\n').length < target) {
    i += 1;
    out.push(line(i));
    if (marks[i]) out.push(...[marks[i]].flat());
  }
  return out;
}

const commands = {
  deps: () => ['npm ls --all (ledger-api@4.18.2)', ...fill(22000, (i) =>
    `${'│  '.repeat(1 + (i % 3))}├── @ledger/${pick(mods)}-${pick(['core', 'utils', 'types', 'client'])}@${1 + (i % 7)}.${i % 13}.${i % 5} deduped`)],
  lint: () => ['eslint . --max-warnings 900', ...fill(22000, (i) =>
    `src/${pick(mods)}/${pick(mods)}.ts:${10 + (i % 400)}:${1 + (i % 60)}  warning  ${pick(['Unexpected any', 'Prefer const', 'Missing return type', 'Unused variable'])}  @typescript-eslint/${pick(['no-explicit-any', 'prefer-const', 'explicit-function-return-type', 'no-unused-vars'])}`),
    '✖ 0 errors, 612 warnings'],
  test: () => ['vitest run --reporter verbose', ...fill(22000, (i) =>
    `  ✓ ${pick(mods)}/${pick(mods)}.spec.ts › ${pick(['handles', 'rejects', 'formats', 'retries', 'caches'])} ${pick(['empty input', 'large batch', 'unicode names', 'timeouts', 'partial refunds'])} #${pad(i)} (${1 + (i % 40)}ms)`, {
      211: ['  ✗ ledger/settle.spec.ts › settles idempotent retries once (1204ms)',
        '    AssertionError: expected 1 charge, got 2 (settle.spec.ts:87)',
        '    Flaky under concurrency. Reproduce with: vitest run ledger/settle.spec.ts --seed 48213'],
    }), 'Tests  1 failed | 412 passed (413)'],
  tree: () => ['find src -type f | sort', ...fill(22000, (i) => `src/${pick(mods)}/${pick(['internal', 'api', 'db', 'jobs'])}/${pick(mods)}-${hex(4)}.ts`)],
  build: () => ['tsc -b && node scripts/bundle.mjs', ...fill(22000, (i) =>
    `[bundle] chunk ${pad(i)} ${pick(mods)}-${hex(6)}.js reused from incremental cache (${2 + (i % 90)} kB)`, {
      140: 'BUNDLE Q7 = sha256:7e4c9a1fd20b (pin this hash in the release note)',
    }), 'Build completed: 1 bundle, 0 errors'],
  env: () => ['node scripts/print-config.mjs --redacted', ...fill(22000, (i) =>
    `${pick(mods).toUpperCase()}_${pick(['TIMEOUT_MS', 'POOL_SIZE', 'RETRY_LIMIT', 'REGION', 'LOG_LEVEL'])}_${pad(i, 3)}=${pick(['30000', '16', '3', 'ap-northeast-2', 'info'])}`)],
  bench: () => ['node bench/run.mjs --suite settle', ...fill(22000, (i) =>
    `settle/${pick(['single', 'batch', 'retry'])}-${pad(i, 3)}  ops/s=${800 + Math.floor(rnd() * 400)}  p50=${40 + Math.floor(rnd() * 30)}ms  p95=${150 + Math.floor(rnd() * 90)}ms`), 'Summary: p95 212ms (budget 250ms)'],
  audit: () => ['npm audit --omit=dev', ...fill(22000, (i) =>
    `  info  ${pick(mods)}-${pick(['parser', 'client', 'glob'])}@${1 + (i % 5)}.${i % 9}.0  advisory GHSA-${hex(4)}-${hex(4)}  severity: low  path: ledger-api > ${pick(mods)}`), '0 high, 0 critical'],
  release: () => {
    const id = `rel-0926-${randomBytes(3).toString('hex')}`;
    const token = `rbk_${randomBytes(8).toString('hex')}`;
    if (process.env.LEDGER_TRUTH) writeFileSync(process.env.LEDGER_TRUTH, JSON.stringify({ releaseId: id, rollbackToken: token, at: new Date().toISOString() }, null, 2));
    return ['deploy canary ledger-api@4.18.2 (one-time: running again creates a NEW release with new ids)', ...fill(22000, (i) =>
      `[canary] upload part ${pad(i)} ${hex(8)} ok (${1 + (i % 64)} MiB)`, {
        120: `RELEASE ID = ${id}`,
        240: `ROLLBACK TOKEN = ${token} (only valid for this release; not recoverable later)`,
      }), 'Canary live at 5% traffic'];
  },
  logs: () => ['kubectl logs deploy/ledger-api --since=10m', ...fill(22000, (i) =>
    `2026-09-26T05:${pad(i % 60, 2)}:${pad((i * 7) % 60, 2)}Z INFO ${pick(mods)} request_id=${hex(12)} status=200 dur=${5 + (i % 90)}ms`)],
  metrics: () => ['curl -s localhost:9090/metrics | grep ledger_', ...fill(22000, (i) =>
    `ledger_${pick(mods)}_${pick(['requests_total', 'errors_total', 'latency_bucket'])}{route="/${pick(mods)}",le="${pick(['0.05', '0.1', '0.25', '+Inf'])}"} ${Math.floor(rnd() * 90000)}`)],
  migrations: () => ['node scripts/migrate.mjs --status', ...fill(22000, (i) =>
    `  applied  ${pad(i, 5)}_${pick(['add', 'drop', 'alter'])}_${pick(mods)}_${pick(['index', 'column', 'table'])}.sql  (${2020 + (i % 6)}-0${1 + (i % 9)}-1${i % 9})`), 'No pending migrations'],
  flags: () => ['node scripts/flags.mjs --list', ...fill(22000, (i) =>
    `flag ${pick(mods)}.${pick(['beta', 'v2', 'fastpath', 'legacy'])}_${pad(i, 3)}  ${pick(['on', 'off'])}  owner=${pick(['pay', 'core', 'risk'])}  updated=2026-0${1 + (i % 9)}-2${i % 9}`)],
  changelog: () => ['git log --oneline v4.18.1..HEAD', ...fill(22000, (i) =>
    `${hex(7)} ${pick(['fix', 'chore', 'feat', 'refactor'])}(${pick(mods)}): ${pick(['tidy imports', 'bump deps', 'rename helper', 'adjust retry', 'log context'])} #${3000 + i}`)],
};

if (!commands[cmd]) {
  console.error(`usage: ledger-tool <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
process.stdout.write(`${commands[cmd]().join('\n')}\n`);
