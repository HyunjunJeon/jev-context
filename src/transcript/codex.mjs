// Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function parse(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

const list = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** A thread's rollout: next to `near` first, then anywhere under the sessions root (YYYY/MM/DD). */
function findRollout(near, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const beside = list(near).find((d) => d.isFile() && d.name.endsWith(suffix));
  if (beside) return join(near, beside.name);
  const at = near.lastIndexOf('/sessions');
  if (at < 0) return null;
  const walk = (dir, depth) => {
    for (const d of list(dir)) {
      if (d.isFile() && d.name.endsWith(suffix)) return join(dir, d.name);
      if (d.isDirectory() && depth < 3) {
        const found = walk(join(dir, d.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(near.slice(0, at + '/sessions'.length), 0);
}

/**
 * A rollout's lines with its whole history. Codex 0.158 forks by reference:
 * the fork's session_meta carries `history_base` {thread_id,
 * end_ordinal_exclusive}, its own lines continue the parent's ordinals, and
 * the parent's lines below that ordinal are its history (measured). Without
 * this a forked session's PreCompact saw none of the tool output it inherited.
 */
function readLines(path, depth = 0) {
  const own = parse(path);
  const base = own.find((e) => e.type === 'session_meta')?.payload?.history_base;
  if (!base?.thread_id || depth > 8) return own;
  const parent = findRollout(dirname(path), base.thread_id);
  if (!parent) return own;
  const inherited = readLines(parent, depth + 1).filter((e) => typeof e.ordinal !== 'number' || e.ordinal < base.end_ordinal_exclusive);
  return [...inherited, ...own];
}

const isCompaction = (e) => e.type === 'compacted' || e.payload?.type === 'compacted' || e.payload?.type === 'context_compacted';

// Codex 0.158 stores an exec result as "Script completed\nWall time …\nOutput:\n"
// followed by JSON whose `output` holds the command's text with its newlines.
const EXEC_ENVELOPE = /^[\s\S]*?\nOutput:\n(\{[\s\S]*\})\s*$/;

function unwrap(text) {
  for (const candidate of [text, text.match(EXEC_ENVELOPE)?.[1]]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed.output === 'string') return parsed.output;
    } catch {
      // plain text output
    }
  }
  return text;
}

function outputText(output) {
  if (typeof output === 'string') return unwrap(output);
  if (Array.isArray(output)) return unwrap(output.map((b) => b.text ?? '').join(''));
  if (output && typeof output === 'object') return output.content ?? output.output ?? JSON.stringify(output);
  return '';
}

function commandOf(p) {
  if (p.type === 'local_shell_call') return [].concat(p.action?.command ?? []).join(' ');
  const raw = p.arguments ?? p.input ?? '';
  if (typeof raw === 'string') {
    try {
      const args = JSON.parse(raw);
      return [].concat(args.command ?? args.cmd ?? raw).join(' ');
    } catch {
      const cmd = raw.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return cmd ? JSON.parse(`"${cmd[1]}"`) : raw.slice(0, 200);
    }
  }
  return JSON.stringify(raw).slice(0, 200);
}

/** Messages (ConversationMessage shape) and tool results after the last compaction. */
export function conversation(path, { limit = 60, resultChars = 4000 } = {}) {
  const lines = readLines(path);
  const start = lines.findLastIndex(isCompaction) + 1;
  const messages = [];
  const calls = new Map();
  const results = [];
  for (const { type, payload: p } of lines.slice(start)) {
    if (type !== 'response_item' || !p) continue;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content ?? []).map((b) => b.text ?? '').join('');
      if (p.role === 'user' && /^\s*<(environment_context|user_instructions|permissions)/.test(text)) continue;
      messages.push({ role: p.role, text, toolUses: [], toolResults: [] });
    } else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
      const command = commandOf(p);
      calls.set(p.call_id, { tool: p.name ?? 'shell', command });
      const last = messages.at(-1)?.role === 'assistant' ? messages.at(-1) : messages[messages.push({ role: 'assistant', text: '', toolUses: [], toolResults: [] }) - 1];
      last.toolUses.push({ tool_use_id: p.call_id, tool: p.name ?? 'shell', input: { command } });
    } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) {
      const text = outputText(p.output);
      const call = calls.get(p.call_id) ?? { tool: '?', command: '' };
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: p.call_id, text: text.slice(0, resultChars) }] });
      results.push({ id: p.call_id, tool: call.tool, command: `${call.tool} ${call.command}`.slice(0, 220), text });
    }
  }
  return { messages: messages.slice(-limit), results };
}

/** A subagent's report: its last assistant message, from the rollout when readable. */
export function finalReport(agentTranscriptPath, fallback = '') {
  const lines = readLines(agentTranscriptPath);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const p = lines[i].payload;
    if (lines[i].type === 'response_item' && p?.type === 'message' && p.role === 'assistant') {
      const text = (p.content ?? []).map((b) => b.text ?? '').join('');
      return text.length >= fallback.length ? text : fallback;
    }
  }
  return fallback;
}
