// Replays the long reads of real Claude Code transcripts through the read gate
// with live Jev, and compares each verdict with hindsight: how much of what was
// read the agent actually used in its next responses. Sends the conversation
// before each read and an outline of the read text to TypeSafe.
//   node scripts/eval-readgate.mjs <transcript.jsonl> [...]
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../src/core/config.mjs';
import { assessRead, outline } from '../src/core/readgate.mjs';
import { conversation, goalOf } from '../src/transcript/claude.mjs';

const cfg = config();
if (cfg.jev !== 'live') {
  console.error('Set TYPESAFE_API_KEY and JEV_CONTEXT_JEV=live: this evaluation asks live Jev.');
  process.exit(2);
}
const WINDOW = 8;
const TOKEN = /[A-Za-z_][A-Za-z0-9_.-]{5,}|\d{3,}|[가-힣]{3,}/g;
const toks = (s) => new Set(s.match(TOKEN) ?? []);

function readKind(name, input) {
  if (name === 'Read') return { kind: input.offset || input.limit ? 'Read(range)' : 'Read(whole)', from: Number(input.offset ?? 1) };
  const cmd = String(input.command ?? '').trim().replace(/^(cd [^&;]+&&\s*)+/, '');
  const head = cmd.split(/\s+/)[0];
  if (!['cat', 'sed', 'head', 'tail', 'nl'].includes(head)) return null;
  const range = cmd.match(/^sed -n '?(\d+),/);
  return { kind: head === 'cat' && !cmd.includes('|') ? 'cat(whole)' : 'range', from: range ? Number(range[1]) : 1 };
}

/** Share of the read (by chars) whose chunk-specific tokens or lines never came back in the next responses. */
function unusedShare(text, before, later) {
  const blob = later.join('\n');
  const lines = text.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += 20) chunks.push(lines.slice(i, i + 20).join('\n'));
  const counts = new Map();
  for (const ch of chunks) for (const t of toks(ch)) counts.set(t, (counts.get(t) ?? 0) + 1);
  let unused = 0;
  for (const ch of chunks) {
    const specific = [...toks(ch)].filter((t) => counts.get(t) === 1 && !before.has(t));
    const used = specific.some((t) => blob.includes(t)) || ch.split('\n').some((l) => l.trim().length >= 25 && blob.includes(l.split('\t').pop().trim()));
    if (!used) unused += ch.length;
  }
  return unused / Math.max(1, text.length);
}

const rows = [];
for (const file of process.argv.slice(2)) {
  const entries = readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((e) => !e.isSidechain);
  let segStart = 0;
  const calls = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.type === 'system' && e.subtype === 'compact_boundary') segStart = i + 1;
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const b of content) {
      if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input ?? {} });
      if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue;
      const { name, input } = calls.get(b.tool_use_id);
      const kind = readKind(name, input);
      if (!kind) continue;
      const raw = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('');
      const text = raw.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n');
      const lines = text.split('\n');
      if (lines.length < cfg.readGateLines) continue;
      // What the agent knew when it issued the read: the conversation up to the call.
      const { messages } = conversation(entries.slice(segStart, i), { limit: 20 });
      const numbered = Array(kind.from - 1).fill('').concat(lines);
      const size = { lines: numbered, total: numbered.length, from: kind.from, to: numbered.length, count: lines.length };
      const verdict = await assessRead(cfg, { command: input.command ?? `Read ${input.file_path}`, file: input.file_path ?? String(input.command).split(/\s+/).pop(), size, goal: goalOf(messages), messages });
      // Hindsight: the next WINDOW assistant responses.
      const later = [];
      const ids = new Set();
      for (let j = i + 1; j < entries.length && ids.size <= WINDOW; j += 1) {
        const ej = entries[j];
        if (ej.type === 'system' && ej.subtype === 'compact_boundary') break;
        if (ej.type !== 'assistant') continue;
        ids.add(ej.message?.id);
        for (const bb of ej.message?.content ?? []) {
          if (bb.type === 'text') later.push(bb.text);
          if (bb.type === 'tool_use') later.push(JSON.stringify(bb.input));
        }
      }
      const before = toks(JSON.stringify(input) + messages.slice(-6).map((m) => m.text).join('\n'));
      // Intent evidence available to a hook at call time.
      let callMsg = null;
      for (let j = i - 1; j >= segStart; j -= 1) {
        if (entries[j].type === 'assistant' && (entries[j].message?.content ?? []).some((x) => x.type === 'tool_use' && x.id === b.tool_use_id)) { callMsg = entries[j].message.id; break; }
      }
      const ownText = entries.slice(segStart, i).filter((x) => x.type === 'assistant' && x.message?.id === callMsg)
        .flatMap((x) => x.message.content).filter((x) => x.type === 'text').map((x) => x.text).join(' ').trim();
      let since = 0;
      const seenIds = new Set();
      for (let j = i - 1; j >= segStart; j -= 1) {
        const x = entries[j];
        if (x.type === 'user' && !x.isMeta && typeof x.message?.content === 'string' && !x.message.content.startsWith('<')) break;
        if (x.type === 'assistant' && !seenIds.has(x.message?.id)) { seenIds.add(x.message?.id); since += 1; }
      }
      rows.push({
        ownText: ownText.length, since,
        session: file.split('/').pop().slice(0, 8), kind: kind.kind, lines: lines.length, chars: text.length,
        p: Number(verdict.p.toFixed(3)), outlineChars: outline(numbered, input.file_path ?? input.command ?? '').join('\n').length,
        unused: Number(unusedShare(text, before, later).toFixed(3)),
        intent: (messages.filter((m) => m.role === 'assistant' && m.text.trim()).at(-1)?.text ?? '').slice(0, 90).replace(/\n/g, ' '),
      });
      process.stderr.write('.');
    }
  }
}
process.stderr.write('\n');
writeFileSync(new URL('../logs/eval-readgate.json', import.meta.url), JSON.stringify(rows, null, 2));

const denied = rows.filter((r) => r.p < 0.5);
const allowed = rows.filter((r) => r.p >= 0.5);
const mean = (xs, f) => (xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : NaN);
const weighted = (xs) => xs.reduce((s, r) => s + r.unused * r.chars, 0) / Math.max(1, xs.reduce((s, r) => s + r.chars, 0));
// How often a read that went mostly unused got a lower p than one that was mostly used.
const lo = rows.filter((r) => r.unused >= 0.5);
const hi = rows.filter((r) => r.unused < 0.2);
let wins = 0;
for (const a of lo) for (const b of hi) wins += a.p < b.p ? 1 : a.p === b.p ? 0.5 : 0;
const total = rows.reduce((s, r) => s + r.chars, 0);
const saved = denied.reduce((s, r) => s + Math.max(0, r.unused * r.chars - r.outlineChars), 0);
console.log(`long reads replayed: ${rows.length} (${total.toLocaleString()} chars) | Jev would turn back ${denied.length} (${(100 * denied.length / rows.length).toFixed(0)}%)`);
console.log(`unused within ${WINDOW} responses — turned back: ${(100 * weighted(denied)).toFixed(0)}% | let through: ${(100 * weighted(allowed)).toFixed(0)}%`);
console.log(`ranking (mostly-unused reads get lower p than mostly-used ones): ${lo.length && hi.length ? (wins / (lo.length * hi.length)).toFixed(2) : 'n/a'} over ${lo.length}×${hi.length} pairs (0.5 = chance)`);
console.log(`upper bound on chars saved if each turned-back read were narrowed to what was used, minus its outline: ${saved.toLocaleString()} (${(100 * saved / total).toFixed(0)}% of long-read chars)`);
console.log(`mean p: ${mean(rows, (r) => r.p).toFixed(2)}`);
for (const r of rows) console.log(`  ${r.session} ${r.kind.padEnd(11)} ${String(r.lines).padStart(4)} lines  p=${r.p.toFixed(2)}  unused=${(100 * r.unused).toFixed(0).padStart(3)}%  | ${r.intent}`);
