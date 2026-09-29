// Before the orchestrator reads a long file (or a long range of one), Jev is
// asked whether this step needs all of it. When it does not, the read is
// turned back once with an outline, so the agent picks the part it needs and
// knows it read only part. Asking again reads the whole range.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { noulAnswer } from '../../vendor/jev-pruner/dist/jev.js';
import { asker } from './jev.mjs';

const READ_DEFAULT_LIMIT = 2000; // Claude Code's Read tool
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const OUTLINE_ENTRIES = 40;

export const READ_QUESTION = 'The coding agent is about to read the file range described in `read` (its outline shows the whole file with line numbers). Given the current step, shown by the task and the recent messages, does it need this whole range now, rather than a few specific sections it could choose from the outline? Answer yes when the step is to review, rewrite, summarize, translate or copy the whole range, or when the outline gives no way to find the needed part. Answer no when the step looks for particular functions, settings, sections, values or facts.';

function unquote(word) {
  return word.replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * The file and line range a simple read command asks for, or null when it is
 * not one we can size before running it (pipes, several files, globs, grep).
 */
export function readRequest(command, cwd) {
  let text = command.trim();
  let dir = cwd ?? process.cwd();
  const cd = text.match(/^cd\s+(\S+)\s*&&\s*(.+)$/s);
  if (cd) {
    dir = resolve(dir, unquote(cd[1]));
    text = cd[2].trim();
  }
  if (/[|;&<>`$(){}*?]/.test(text.replace(/'[^']*'|"[^"]*"/g, ''))) return null;
  const words = text.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  const [tool, ...args] = words.map(unquote);
  const file = (name) => (name ? resolve(dir, name) : null);
  let m;
  switch (tool) {
    case 'cat':
    case 'nl':
      return args.length === 1 && !args[0].startsWith('-') ? { file: file(args[0]) } : null;
    case 'sed':
      if (args.length === 3 && args[0] === '-n' && (m = args[1].match(/^(\d+),(\d+|\$)p$/))) {
        return { file: file(args[2]), from: Number(m[1]), to: m[2] === '$' ? Infinity : Number(m[2]) };
      }
      return null;
    case 'head':
    case 'tail': {
      let n = 10;
      let rest = args;
      if (args[0] === '-n' && args[1]) [n, rest] = [args[1], args.slice(2)];
      else if (/^-\d+$/.test(args[0] ?? '')) [n, rest] = [args[0].slice(1), args.slice(1)];
      else if (/^-n\d+$/.test(args[0] ?? '')) [n, rest] = [args[0].slice(2), args.slice(1)];
      if (rest.length !== 1) return null;
      if (tool === 'tail' && String(n).startsWith('+')) return { file: file(rest[0]), from: Number(String(n).slice(1)), to: Infinity };
      if (!/^\d+$/.test(String(n))) return null;
      return tool === 'head' ? { file: file(rest[0]), from: 1, to: Number(n) } : { file: file(rest[0]), last: Number(n) };
    }
    default:
      return null;
  }
}

/** Numbered outline lines: headings, definitions, top-level keys; evenly thinned to a cap. */
export function outline(lines, name = '') {
  const md = /\.(md|mdx|markdown|txt|rst)$/i.test(name);
  const code = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|def|fn|func|impl|struct|trait|module|namespace)\b|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\(|function|class|\{|\[)|^\s*(?:public|private|protected|static)\s+[\w<>[\]]+\s+\w+\s*\(/;
  const picked = [];
  let fenced = false;
  lines.forEach((line, i) => {
    const t = line.trimEnd();
    if (md && /^\s*(```|~~~)/.test(t)) fenced = !fenced;
    if (!t.trim() || fenced) return;
    if (md ? /^#{1,6}\s/.test(t) : code.test(t) || /^[A-Za-z_"'][\w"' -]*:\s*(?:$|[{[])/.test(t)) picked.push([i + 1, t]);
  });
  const unique = picked.filter(([, t], i, all) => i === 0 || all[i - 1][1] !== t);
  const step = Math.max(1, Math.ceil(unique.length / OUTLINE_ENTRIES));
  return unique.filter((_, i) => i % step === 0).map(([n, t]) => `${String(n).padStart(5)}: ${t.slice(0, 120)}`);
}

/** How many lines the request would print, with the file's lines, or null. */
export function sizeRequest(request) {
  if (!request?.file || !existsSync(request.file)) return null;
  const stat = statSync(request.file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  const lines = readFileSync(request.file, 'utf8').split('\n');
  const total = lines.length;
  let from = request.from ?? 1;
  let to = request.to ?? total;
  if (request.last !== undefined) [from, to] = [Math.max(1, total - request.last + 1), total];
  to = Math.min(to, total);
  return { lines, total, from, to, count: Math.max(0, to - from + 1) };
}

/** Claude Code's Read tool input as a request. */
export function readToolRequest(input, cwd) {
  if (!input?.file_path) return null;
  const from = input.offset ? Number(input.offset) : 1;
  return { file: resolve(cwd ?? process.cwd(), input.file_path), from, to: from + (input.limit ? Number(input.limit) : READ_DEFAULT_LIMIT) - 1 };
}

/**
 * Jev's judgment on one sized read: `{ p, needed, outline, requests }`, or
 * `{ skipped }` when Jev is not available.
 */
export async function assessRead(cfg, { command, file, size, goal, messages }) {
  const counter = { requests: 0 };
  const jev = asker(cfg, counter);
  if (!jev) return { skipped: 'no_jev' };
  const entries = outline(size.lines, file);
  const state = {
    task: goal,
    recent_messages: messages.filter((m) => m.text?.trim()).slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 500) })),
    read: {
      command,
      file,
      requested_lines: `${size.from}-${size.to} of ${size.total}`,
      outline: entries,
      first_lines: size.lines.slice(size.from - 1, size.from + 11).map((l) => l.slice(0, 160)),
    },
  };
  const { answers } = await jev.ask(state, { whole_range_needed: { type: 'noul', instructions: READ_QUESTION } });
  const p = noulAnswer(answers, 'whole_range_needed');
  return { p, needed: p >= 0.5, outline: entries, requests: counter.requests };
}

export function denyMessage({ file, size, p, outline: entries, command }) {
  const example = entries.length > 1
    ? `sed -n '${entries[1].trim().split(':')[0]},${Math.min(size.total, Number(entries[1].trim().split(':')[0]) + 60)}p' ${file}`
    : `sed -n '1,60p' ${file}`;
  return [
    `[jev-context] Reading lines ${size.from}-${size.to} (${size.count} lines) of ${file} looks broader than this step needs (Jev p=${p.toFixed(2)}). Outline of the whole file (${size.total} lines):`,
    ...(entries.length ? entries : ['  (no headings or definitions found)']),
    `Read only the part you need, e.g. \`${example}\` or \`grep -n <term> ${file}\`, or the Read tool with offset/limit. To read the whole range anyway, run the same ${command ? 'command' : 'read'} again.`,
  ].join('\n');
}
