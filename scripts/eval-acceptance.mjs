// Phase 0 of the acceptance check: score real subagent reports with live Jev
// and see how often each rule would send a report back.
//   node scripts/eval-acceptance.mjs logs/acceptance-dataset.json
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../src/core/config.mjs';
import { scoreReport } from '../src/core/acceptance.mjs';

const cfg = config();
if (cfg.jev !== 'live') { console.error('Set TYPESAFE_API_KEY and JEV_CONTEXT_JEV=live.'); process.exit(2); }
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const r of rows) {
  const t = Date.now();
  const s = await scoreReport(cfg, { brief: r.brief, originalBrief: r.original_brief, report: r.report });
  out.push({ id: r.id, round: r.round, fixFollowUp: r.fixFollowUp, briefChars: r.brief.length, reportChars: r.report.length, ms: Date.now() - t, ...s });
  process.stderr.write('.');
}
process.stderr.write('\n');
writeFileSync(new URL('../logs/eval-acceptance.json', import.meta.url), JSON.stringify(out, null, 1));
const rate = (f) => `${out.filter(f).length}/${out.length} (${(100 * out.filter(f).length / out.length).toFixed(0)}%)`;
const q = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? `min ${s[0].toFixed(2)} · p25 ${s[Math.floor(s.length / 4)].toFixed(2)} · median ${s[Math.floor(s.length / 2)].toFixed(2)}` : 'n/a'; };
console.log(`reports scored: ${out.length} | with items: ${out.filter((r) => r.items.length).length} | development: ${out.filter((r) => r.development).length} | Jev ms median ${q(out.map((r) => r.ms)).split('median ')[1]}`);
console.log(`on_target: ${q(out.map((r) => r.onTarget))}`);
console.log(`min item score (where items): ${q(out.filter((r) => r.items.length).map((r) => Math.min(...r.itemScores)))}`);
console.log(`evidence (development): ${q(out.filter((r) => r.development).map((r) => r.evidence))}`);
console.log('would be sent back —');
console.log(`  on_target < 0.4:        ${rate((r) => r.onTarget < 0.4)}`);
console.log(`  any item < 0.3:         ${rate((r) => r.items.length && Math.min(...r.itemScores) < 0.3)}`);
console.log(`  evidence < 0.3 (dev):   ${rate((r) => r.development && r.evidence < 0.3)}`);
console.log(`  any of the three:       ${rate((r) => r.onTarget < 0.4 || (r.items.length && Math.min(...r.itemScores) < 0.3) || (r.development && r.evidence < 0.3))}`);
