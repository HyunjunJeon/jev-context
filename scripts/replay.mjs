// Replays real Claude Code transcripts through the prune pipeline (rules only,
// no Jev calls) and reports how much of the Bash output the model saw would
// have been kept. Reads local transcripts; prints only counts and sizes.
//   node scripts/replay.mjs <transcript.jsonl> [...]
import { existsSync, readFileSync } from 'node:fs';
import { config } from '../src/core/config.mjs';
import { pruneOutput } from '../src/core/prune.mjs';

const cfg = { ...config(), jev: 'off' };
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/replay.mjs <transcript.jsonl> [...]');
  process.exit(2);
}

const text = (content) => (typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join(''));
const total = { outputs: 0, before: 0, after: 0, stages: {} };
for (const file of files) {
  const calls = new Map();
  const row = { outputs: 0, before: 0, after: 0 };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    // A subagent's own transcript is all sidechain; the main one mixes them in.
    if (e.isSidechain && !file.includes('/subagents/')) continue;
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b.type === 'tool_use' && b.name === 'Bash') calls.set(b.id, b.input?.command ?? '');
      if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue;
      const seen = text(b.content);
      // For an output Claude Code saved to a file, prune the saved original
      // against the preview budget, as the hook does.
      const saved = e.toolUseResult?.persistedOutputPath;
      const persisted = saved && existsSync(saved);
      const output = persisted ? readFileSync(saved, 'utf8') : seen;
      const result = await pruneOutput(cfg, {
        command: calls.get(b.tool_use_id),
        output,
        budget: persisted ? seen.length : Infinity,
        archivePath: persisted ? saved : '/replay/archive.txt',
      });
      row.outputs += 1;
      row.before += seen.length;
      row.after += result.text ? result.text.length : seen.length;
      total.stages[result.stage] = (total.stages[result.stage] ?? 0) + 1;
    }
  }
  console.log(`${file.split('/').pop().slice(0, 8)}  bash outputs=${row.outputs}  chars seen ${row.before.toLocaleString()} → ${row.after.toLocaleString()}  (−${(100 * (1 - row.after / Math.max(1, row.before))).toFixed(1)}%)`);
  total.outputs += row.outputs;
  total.before += row.before;
  total.after += row.after;
}
console.log(`all  bash outputs=${total.outputs}  chars seen ${total.before.toLocaleString()} → ${total.after.toLocaleString()}  (−${(100 * (1 - total.after / Math.max(1, total.before))).toFixed(1)}%)`);
console.log('decisions:', JSON.stringify(total.stages));
