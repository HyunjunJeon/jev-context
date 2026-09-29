// Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl).
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

const TAIL_BYTES = 8 * 1024 * 1024;

function readTail(path) {
  if (!path || !existsSync(path)) return [];
  const fd = openSync(path, 'r');
  let text;
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

/** The main-chain entries the model still sees: everything after the last compaction. */
export function readEntries(path) {
  const entries = readTail(path);
  const boundary = entries.findLastIndex((e) => e.type === 'system' && e.subtype === 'compact_boundary');
  return entries.slice(boundary + 1).filter((e) => !e.isSidechain);
}

/**
 * Whether the last compaction will be undone on resume. Claude Code rebuilds a
 * resumed conversation by following parentUuid back from the newest entry. A
 * built-in summary starts a fresh chain at its boundary; a compaction built by
 * a function hook keeps tool results that still point at their old parents,
 * so the walk runs past the boundary and the whole history comes back
 * (2.1.284, measured: 18k tokens after compaction, 205k after --resume).
 * Returns the boundary (uuid, token counts) when that happens, otherwise null.
 */
export function lostCompaction(path) {
  const entries = readTail(path);
  const boundary = entries.findLastIndex((e) => e.type === 'system' && e.subtype === 'compact_boundary');
  if (boundary < 0) return null;
  const at = new Map(entries.map((e, i) => [e.uuid, i]).filter(([uuid]) => uuid));
  let i = entries.findLastIndex((e) => e.uuid && (e.type === 'user' || e.type === 'assistant'));
  const seen = new Set();
  while (i !== undefined && i > boundary && !seen.has(i)) {
    seen.add(i);
    const parent = entries[i].parentUuid;
    i = parent ? at.get(parent) : undefined;
  }
  if (i === undefined || i >= boundary) return null;
  const meta = entries[boundary].compactMetadata ?? {};
  return { boundary: entries[boundary].uuid, preTokens: meta.preTokens, postTokens: meta.postTokens };
}

const blockText = (content) => (typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join(''));

/** Last real model response: when, the context the next request re-sends, the cache TTL it wrote with. */
export function lastResponse(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const { type, message, timestamp } = entries[i];
    if (type !== 'assistant' || !message?.usage || message.model === '<synthetic>') continue;
    const u = message.usage;
    let ttlSeconds = null;
    for (let j = i; j >= 0 && ttlSeconds === null; j -= 1) {
      const written = entries[j].message?.usage?.cache_creation;
      if (written?.ephemeral_1h_input_tokens > 0) ttlSeconds = 3600;
      else if (written?.ephemeral_5m_input_tokens > 0) ttlSeconds = 300;
    }
    return {
      at: Date.parse(timestamp),
      contextTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
      ttlSeconds,
    };
  }
  return null;
}

/**
 * The conversation in jev-pruner's ConversationMessage shape plus the tool
 * results with the call that produced them, newest `limit` messages.
 */
export function conversation(entries, { limit = 60, resultChars = 4000 } = {}) {
  const messages = [];
  const calls = new Map();
  const results = [];
  for (const { type, message, isMeta } of entries) {
    if ((type !== 'user' && type !== 'assistant') || !message || isMeta) continue;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
    let current = messages.at(-1);
    // Claude Code writes each content block of one response as its own line.
    if (!(type === 'assistant' && current?.role === 'assistant' && current.id === message.id)) {
      current = { role: type, id: message.id, text: '', toolUses: [], toolResults: [] };
      messages.push(current);
    }
    for (const block of blocks) {
      if (block.type === 'text') current.text += (current.text ? '\n' : '') + block.text;
      if (block.type === 'tool_use') {
        current.toolUses.push({ tool_use_id: block.id, tool: block.name, input: block.input ?? {} });
        calls.set(block.id, { tool: block.name, input: block.input ?? {} });
      }
      if (block.type === 'tool_result') {
        const text = blockText(block.content);
        current.toolResults.push({ tool_use_id: block.tool_use_id, text: text.slice(0, resultChars), isError: block.is_error === true });
        const call = calls.get(block.tool_use_id) ?? { tool: '?', input: {} };
        results.push({ id: block.tool_use_id, tool: call.tool, command: describe(call), text });
      }
    }
  }
  return { messages: messages.slice(-limit).map(({ id, ...rest }) => rest), results };
}

function describe({ tool, input }) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? '';
  return `${tool}${detail ? ` ${String(detail).slice(0, 200)}` : ''}`;
}

/**
 * How visible a tool call's purpose is: the text the agent wrote in the
 * response that makes the call, and how many responses have passed since the
 * user's last request (a notification or hand-back is not a request).
 */
export function intentEvidence(messages) {
  const isRequest = (m) => m.role === 'user' && m.text.trim() && m.toolResults.length === 0 && !m.text.trimStart().startsWith('<');
  let ownText = 0;
  let since = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isRequest(m)) break;
    if (m.role !== 'assistant') continue;
    if (since === 0) ownText = m.text.trim().length;
    since += 1;
  }
  return { ownText, since };
}

/** What the user asked for lately, as jev-pruner's own Claude hook builds its goal. */
export function goalOf(messages) {
  return messages
    .filter((m) => m.role === 'user' && m.text.trim() && m.toolResults.length === 0)
    .slice(-3)
    .map((m) => m.text.slice(0, 500))
    .join('\n');
}

/**
 * A subagent's report as its parent receives it: the assistant text after the
 * last user entry (tool result or instruction), which can span several
 * messages; `last_assistant_message` holds only the last one. Matched the
 * delivered result within 5% for 102 of 106 notifications in a real session.
 */
export function finalReport(agentTranscriptPath, fallback = '') {
  const entries = readTail(agentTranscriptPath).filter((e) => e.type === 'user' || e.type === 'assistant');
  const texts = [];
  for (let i = entries.length - 1; i >= 0 && entries[i].type === 'assistant'; i -= 1) {
    const { content } = entries[i].message ?? {};
    const text = typeof content === 'string' ? content : blockText((content ?? []).filter((b) => b.type === 'text'));
    if (text) texts.unshift(text);
  }
  const report = texts.join('\n\n');
  return report.length >= fallback.length ? report : fallback;
}
