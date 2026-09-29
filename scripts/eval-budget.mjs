// Phase 0 of the brief-aware report budget: Jev picks a detail level from each
// real brief; does it match how much of the report's detail the coordinator
// then used?   node scripts/eval-budget.mjs logs/budget-dataset.json
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../src/core/config.mjs';
import { chooseLevel, LEVELS } from '../src/core/budget.mjs';

const cfg = config();
if (cfg.jev !== 'live') { console.error('Set TYPESAFE_API_KEY and JEV_CONTEXT_JEV=live.'); process.exit(2); }
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const r of rows) {
  const t = Date.now();
  const v = await chooseLevel(cfg, { brief: r.brief, originalBrief: r.original_brief });
  out.push({ id: r.id, reportChars: r.reportChars, cov3: r.cov3, cov8: r.cov8, cov20: r.cov20, ms: Date.now() - t, ...v, brief: r.brief.slice(0, 160) });
  process.stderr.write('.');
}
process.stderr.write('\n');
writeFileSync(new URL('../logs/eval-budget.json', import.meta.url), JSON.stringify(out, null, 1));

const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const rank = (xs) => { const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = Array(xs.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
const spearman = (a, b) => { const ra = rank(a), rb = rank(b), n = a.length, ma = (n - 1) / 2; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; } return num / Math.sqrt(da * db); };
console.log(`briefs judged: ${out.length} | Jev ms median ${med(out.map((r) => r.ms))}`);
for (const level of Object.keys(LEVELS)) {
  const g = out.filter((r) => r.level === level);
  console.log(`  ${level.padEnd(12)} n=${String(g.length).padStart(3)}  report chars median ${med(g.map((r) => r.reportChars))}  detail used: cov3 ${med(g.map((r) => r.cov3))}  cov8 ${med(g.map((r) => r.cov8))}  cov20 ${med(g.map((r) => r.cov20))}`);
}
for (const n of ['cov3', 'cov8', 'cov20']) {
  const xs = out.filter((r) => r[n] != null);
  console.log(`Spearman(expected detail level, ${n}) = ${spearman(xs.map((r) => r.expected), xs.map((r) => r[n])).toFixed(2)}  (want > 0)`);
}
const lo = out.filter((r) => r.level === 'conclusion'); const hi = out.filter((r) => r.level !== 'conclusion');
let wins = 0; for (const a of lo) for (const b of hi) wins += a.cov8 < b.cov8 ? 1 : a.cov8 === b.cov8 ? 0.5 : 0;
console.log(`ranking: a 'conclusion' report used less detail than a more detailed one: ${lo.length && hi.length ? (wins / (lo.length * hi.length)).toFixed(2) : 'n/a'} over ${lo.length}×${hi.length} pairs (0.5 = chance)`);
const total = out.reduce((s, r) => s + r.reportChars, 0);
const saved = out.reduce((s, r) => s + (r.budget ? Math.max(0, r.reportChars - r.budget) : 0), 0);
console.log(`report chars that would move from the coordinator's window to files: ${saved.toLocaleString()} of ${total.toLocaleString()} (${(100 * saved / total).toFixed(0)}%)`);
console.log(`risk: 'conclusion' reports whose detail was heavily used (cov8 ≥ 0.5): ${lo.filter((r) => r.cov8 >= 0.5).length}/${lo.length}`);
