// Deterministic reduction of command output. Nothing here guesses what the
// task needs: it only folds what is structurally repetitive, and it never
// folds a line jev-pruner treats as a diagnostic or a result.
import { isProtectedLine } from '../../vendor/jev-pruner/dist/retention.js';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const MIN_RUN = 6;
const FOLD_MARK = /^\[… \d+ similar lines …\]$/;
const SIMILARITY = 0.7;

/** A line's shape: words kept, numbers and long hex runs abstracted. */
function shape(line) {
  return line
    .toLowerCase()
    .replace(/[0-9a-f]{6,}/g, '<h>')
    .replace(/\d+/g, '#')
    .split(/[^a-z#<>]+/)
    .filter(Boolean);
}

function similar(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] === b[i]) same += 1;
  return same / Math.max(a.length, b.length) >= SIMILARITY;
}

/** Only the final state of a line rewritten with carriage returns (progress bars). */
function settle(line) {
  if (!line.includes('\r')) return line;
  const parts = line.split('\r').filter((part) => part.length > 0);
  return parts.at(-1) ?? '';
}

/**
 * Folds runs of at least MIN_RUN similar lines to their first two and last
 * line plus a count, strips ANSI codes, settles progress bars, squeezes blank
 * runs. Returns the text and how many lines were folded away.
 */
export function reduceOutput(text) {
  const lines = text.replace(ANSI, '').split('\n').map(settle);
  const out = [];
  let folded = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      if (out.at(-1)?.trim() !== '' || out.length === 0) out.push('');
      else folded += 1;
      i += 1;
      continue;
    }
    if (isProtectedLine(line)) {
      out.push(line);
      i += 1;
      continue;
    }
    const head = shape(line);
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !isProtectedLine(lines[j]) && similar(head, shape(lines[j]))) j += 1;
    const run = j - i;
    if (run >= MIN_RUN) {
      out.push(lines[i], lines[i + 1], `[… ${run - 3} similar lines …]`, lines[j - 1]);
      folded += run - 3;
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return { text: out.join('\n'), folded };
}

/** A coarser shape than folding uses: any word is `w`, any number `#`, any hex run `h`. */
const outline = (line) => line.trim().replace(/\b[0-9a-f]{4,}\b/gi, 'h').replace(/[A-Za-z]+/g, 'w').replace(/\d+/g, '#').replace(/w(?:[ _-]w)+/g, 'w+');

/**
 * The lines that look like nothing else in their output: in a long log the
 * value, the failure and the summary usually do. The first line (the command
 * banner) is left out. Output where many lines stand out (code, prose, a
 * table of distinct rows) has no standouts by this measure and returns none.
 */
export function standoutLines(text, { minLines = 20, maxShare = 0.05 } = {}) {
  const lines = text.replace(ANSI, '').split('\n').map(settle).filter((line) => line.trim());
  // Output reduceOutput already folded was long, and its repeats are gone:
  // judge what is left however short it is, leaving out the fold markers.
  const folded = lines.some((line) => FOLD_MARK.test(line));
  if (lines.length < (folded ? 1 : minLines)) return [];
  const counts = new Map();
  for (const line of lines) counts.set(outline(line), (counts.get(outline(line)) ?? 0) + 1);
  const rare = lines.slice(1).filter((line) => !FOLD_MARK.test(line) && counts.get(outline(line)) <= 2);
  return rare.length <= Math.max(5, lines.length * (folded ? 0.5 : maxShare)) ? rare : [];
}

/**
 * Standout lines of several outputs, newest (last) first, within a total and a
 * per-output budget. `skip(i, line)` leaves out lines already kept elsewhere.
 */
export function pickStandouts(texts, { budget, perOutput = 1_500, skip = () => false }) {
  const picked = texts.map(() => []);
  let used = 0;
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    let size = 0;
    for (const line of standoutLines(texts[i])) {
      if (skip(i, line) || size + line.length > perOutput || used + size + line.length > budget) continue;
      picked[i].push(line);
      size += line.length + 1;
    }
    used += size;
  }
  return { picked, chars: used };
}
