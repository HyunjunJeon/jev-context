// Verbatim compaction, from fast-jev-compaction: instead of replacing the
// conversation with a summary, drop the tool calls and results Jev says are no
// longer needed and keep every user and assistant text as written. The call
// decisions are the library's own (pinning, whole-history state, batching).
// What this plugin changes, so that it shrinks the window about as far as a
// summary does while keeping the text:
// - Only the first message and results the assistant has not answered yet are
//   pinned. The library pins the newest six messages whole, which after a busy
//   turn kept two 22k-char outputs Jev was never asked about (68% of what was
//   left, live 2026-09-29).
// - The result question is this plugin's. The library keeps a result only when
//   "re-running the tool would not do"; with that premise every result scored
//   below 0.5, even a file the next step was about to edit (0.15-0.18, live
//   2026-09-29). Asked whether the next step edits what the call read (naming
//   the file), Jev scored the file 0.45-0.85 whenever the next step edited it
//   (0.45 when it was read 25 messages earlier), 0.09 once the edit was done,
//   and every log 0.17 or below. So a result stays whole from 0.3
//   (JEV_CONTEXT_COMPACT_KEEP), not the library's 0.5; either mistake is cheap
//   to undo (a few tokens kept, or one re-read). A wording that also counted
//   "values found only in the output" kept whole 22k-char logs; values are the
//   standout rule's job.
// - A dropped result keeps its standout lines (a value, a failure, a summary).
//   That is a rule, not Jev: asked per chunk, Jev scored a 31-chunk test log
//   0.65-0.85 throughout and ranked the failure 7th-8th.
// - Long inputs of calls whose result goes are cut to their head.
// - Assistant messages come back without their thinking. After a compaction
//   no earlier thinking fits the new prefix (preserved thinking), and a summary
//   drops it as well.
// - On by default (cfg.compactTopics; JEV_CONTEXT_COMPACT_TOPICS=off stops it): Jev is also asked, per exchange (a
//   user request and everything up to the next one), whether the user closed
//   its topic. Only a confident yes (0.8, JEV_CONTEXT_COMPACT_TOPIC_DROP) drops
//   it: a topic the user explicitly closed scored 0.87-0.93, one they only
//   moved on from 0.50-0.56, and a dropped exchange cannot be brought back. It
//   leaves a note with the lines that stood out in its tool output. Asked
//   instead whether the work "comes back to" a topic, Jev scored both kinds
//   below 0.5 and a release id went with the closed topic. The first exchange
//   and those in the newest messages are not asked about.
// - Jev is asked only when its answer can change the window (ASK_CALL_CHARS,
//   ASK_EXCHANGE_CHARS); with nothing that large, no request is sent and the
//   built-in summary runs.
// Runs inside Claude Code's function-hook worker, so nothing here imports Node.
import { applyDecisions, batchCalls, messageChars, questionsFor, resolveOptions } from '../../vendor/fast-jev-compaction/dist/compact.js';
import { noulAnswer } from '../../vendor/fast-jev-compaction/dist/request.js';
import { collectToolCalls, fitState } from '../../vendor/fast-jev-compaction/dist/state.js';
import { pickStandouts } from './reduce.mjs';

/** Below this share of characters removed, the built-in summary is used instead. */
export const MIN_REDUCTION = 0.25;
/**
 * Jev is asked only where its answer can change the window: a call whose
 * result and input together are this long, an exchange holding this much.
 * Anything smaller stays as it is without a question, and a compaction with
 * nothing large enough sends no request at all.
 */
export const ASK_CALL_CHARS = 1_000;
export const ASK_EXCHANGE_CHARS = 1_500;

function outputsById(messages) {
  const outputs = new Map();
  for (const message of messages) {
    for (const tool of message.toolUses) if (typeof tool.text === 'string') outputs.set(tool.tool_use_id, tool.text);
    for (const result of message.toolResults ?? []) outputs.set(result.tool_use_id, result.text);
  }
  return outputs;
}

const sourceOf = (input) => [input?.command, input?.file_path, input?.pattern].find((v) => typeof v === 'string') ?? '';

/** First line only (the command banner, capped at `headChars`), a short note, then the standout lines. */
function withKeptLines(original, lines, headChars) {
  const head = original.split('\n', 1)[0].slice(0, headChars);
  return [
    head,
    `[jev-context: ${original.length - head.length} chars dropped at compaction; standout lines kept, re-run for the rest]`,
    ...lines.filter((line) => !head.includes(line)),
  ].join('\n');
}

/** Jev's question about a call's output: will the next step edit what the call read? */
export function resultQuestion(call) {
  const source = sourceOf(call.input).replace(/\s+/g, ' ').slice(0, 120);
  return {
    type: 'noul',
    instructions: `The work right after this compaction edits or rewrites what tool call ${call.id} read (${call.tool}${source ? ` ${source}` : ''}, ${call.resultChars} chars), such as a source file or document, so the assistant needs that text exactly as it was read. Logs, listings and command output whose key lines the assistant already reported do not count.`,
  };
}

/** Pinned calls stay; a result stays whole from `keep`; otherwise the call stays from 0.5 (the library's call question). */
function decide(call, answer, keep) {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= keep) return { ...base, action: 'keep', reason: 'kept' };
  if (answer.keepCall >= 0.5) return { ...base, action: 'drop_result', reason: 'result_dropped' };
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/** The library's call question with this plugin's result question. */
const questionsOf = (call) => ({ ...questionsFor(call), [`result_${call.id}`]: resultQuestion(call) });

/** A result the assistant has already answered in text is no longer pinned; the first message stays pinned. */
function repin(messages, calls) {
  const lastText = messages.findLastIndex((m) => m.role === 'assistant' && m.text.trim());
  return calls.map((call) => (call.pinned && call.callIndex > 0 && call.resultIndex < lastText ? { ...call, pinned: false } : call));
}

const INPUT_HEAD = 300;

/** An input with its long string fields cut to their head; the same object when nothing is long. */
function shortInput(input) {
  let changed = false;
  const out = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === 'string' && value.length > INPUT_HEAD * 2) {
      out[key] = `${value.slice(0, INPUT_HEAD)}[… ${value.length - INPUT_HEAD} chars of this input dropped at compaction]`;
      changed = true;
    } else out[key] = value;
  }
  return changed ? out : input;
}

/** Assistant messages rebuilt without a handle (so without thinking), with the inputs of result-dropped calls cut. */
function withoutThinking(messages, cutInputs, cut = { inputs: 0 }) {
  return messages.flatMap((m) => {
    if (m.role !== 'assistant') return [m];
    const toolUses = m.toolUses.map((tool) => {
      const input = cutInputs.has(tool.tool_use_id) ? shortInput(tool.input) : tool.input;
      if (input === tool.input) return tool;
      cut.inputs += 1;
      const copy = { tool_use_id: tool.tool_use_id, tool: tool.tool, input };
      if (tool.text !== undefined) copy.text = tool.text;
      if (tool.isError) copy.isError = true;
      return copy;
    });
    if (!m.text.trim() && toolUses.length === 0) return [];
    return [{ role: 'assistant', text: m.text, toolUses }];
  });
}

/** Exchanges: a user request (not a tool result, not a harness record) up to the next one. */
function exchangesOf(messages) {
  const starts = messages.flatMap((m, i) => (m.role === 'user' && m.text.trim() && !m.text.trimStart().startsWith('<') && !(m.toolResults ?? []).length ? [i] : []));
  return starts.map((start, k) => ({ id: `e${k + 1}`, start, end: (starts[k + 1] ?? messages.length) - 1 }));
}

/** Exchanges Jev may drop: not the first, not one reaching into the newest messages, none with an unanswered result. */
function topicCandidates(messages, calls, recent) {
  const waiting = calls.filter((c) => c.pinned && c.callIndex > 0).map((c) => c.resultIndex);
  return exchangesOf(messages).filter((e) => e.start > 0 && e.end < messages.length - recent && !waiting.some((i) => i >= e.start && i <= e.end));
}

const inputChars = (input) => {
  try {
    return JSON.stringify(input ?? {}).length;
  } catch {
    return 0;
  }
};
const callChars = (call) => call.resultChars + inputChars(call.input);
const exchangeChars = (messages, t) => messages.slice(t.start, t.end + 1).reduce((sum, m) => sum + messageChars(m), 0);

const opening = (messages, t) => messages[t.start].text.replace(/\s+/g, ' ').trim().slice(0, 200);

/** Jev's question about an exchange: did the user close its topic? */
export function topicQuestion(t, messages) {
  return {
    type: 'noul',
    instructions: `The user closed the topic of the exchange in history entries ${t.start}-${t.end} (it opens with the user saying: "${opening(messages, t)}"): they said it is finished or set it aside, and the remaining work does not come back to it.`,
  };
}

const TOPIC_NOTE_LINES = 600;

/** The note left for a dropped exchange: its opening words and what stood out in its tool output. */
function topicNote(messages, t) {
  const outputs = messages.slice(t.start, t.end + 1).flatMap((m) => (m.toolResults ?? []).map((r) => r.text));
  const lines = pickStandouts(outputs, { budget: TOPIC_NOTE_LINES }).picked.flat();
  const head = `[jev-context: an earlier exchange was dropped at compaction because the user closed its topic. It opened with: "${opening(messages, t).slice(0, 120)}"`;
  return lines.length ? `${head}. Lines that stood out in its tool output:\n${lines.join('\n')}]` : `${head}]`;
}

const count = (decisions, action) => decisions.filter((d) => d.action === action && d.reason !== 'pinned').length;

/**
 * Compacts `messages` (Claude Code's SessionMessage shape). User messages the
 * decisions leave alone come back as the same objects, so the engine keeps its
 * own copy; assistant messages and anything edited come back rebuilt, without
 * a handle. Throws when Jev fails or the history cannot be fitted: the caller
 * falls back to the built-in summary.
 */
export async function compactVerbatim(cfg, messages, jev, { goal = '' } = {}) {
  const started = Date.now();
  const options = resolveOptions({ goal });
  const collected = collectToolCalls(messages, options.preserveRecentMessages);
  const collectedPinned = collected.map((c) => c.pinned);
  const allCalls = repin(messages, collected);
  const unpinned = allCalls.filter((call) => !call.pinned);
  const candidates = unpinned.filter((call) => callChars(call) >= ASK_CALL_CHARS);
  const small = new Set(unpinned.filter((call) => callChars(call) < ASK_CALL_CHARS).map((call) => call.tool_use_id));
  const exchanges = cfg.compactTopics === 'on' ? topicCandidates(messages, allCalls, options.preserveRecentMessages) : [];
  const topics = exchanges.filter((t) => exchangeChars(messages, t) >= ASK_EXCHANGE_CHARS);
  const charsBefore = messages.reduce((sum, m) => sum + messageChars(m), 0);
  const base = { calls: allCalls.length, charsBefore };
  if (candidates.length === 0 && topics.length === 0) return { stage: 'no_candidates', messages, stats: { ...base, charsAfter: charsBefore, reduction: 0 } };

  // 1. Questions per call (and per exchange when asked for), with the whole
  // history (results as notes) as state; the requests run side by side.
  const fitted = fitState(messages, allCalls, options);
  const answers = new Map();
  const topicP = new Map();
  await Promise.all([
    ...batchCalls(candidates, fitted.tokens, options).map(async (batch) => {
      const { answers: got } = await jev.ask(fitted.state, Object.assign({}, ...batch.map(questionsOf)));
      for (const call of batch) answers.set(call.id, { keepCall: noulAnswer(got, `call_${call.id}`), keepResult: noulAnswer(got, `result_${call.id}`) });
    }),
    topics.length > 0 && (async () => {
      const { answers: got } = await jev.ask(fitted.state, Object.fromEntries(topics.map((t) => [`topic_${t.id}`, topicQuestion(t, messages)])));
      for (const t of topics) topicP.set(t.id, noulAnswer(got, `topic_${t.id}`));
    })(),
  ]);
  const keep = cfg.compactKeep ?? 0.3;
  // A call too small to ask about stays as it is.
  const decisionOf = new Map(allCalls.map((call) => [call.tool_use_id, small.has(call.tool_use_id)
    ? { id: call.id, tool: call.tool, keepCall: 1, keepResult: 1, action: 'keep', reason: 'small' }
    : decide(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, keep)]));

  // 2. Exchanges whose topic the user closed go whole; the next kept request
  // carries a note that they existed. Calls are then collected again over
  // what is left, with the answers they already got.
  const gone = topics.filter((t) => topicP.get(t.id) >= (cfg.compactTopicDrop ?? 0.8));
  const dropIndex = new Set(gone.flatMap((t) => Array.from({ length: t.end - t.start + 1 }, (_, k) => t.start + k)));
  const notes = new Map();
  for (const t of gone) {
    let next = t.end + 1;
    while (dropIndex.has(next)) next += 1;
    const opener = messages[next];
    if (opener) notes.set(opener, [...(notes.get(opener) ?? []), topicNote(messages, t)]);
  }
  const left = messages.filter((_, i) => !dropIndex.has(i));
  const calls = gone.length ? repin(left, collectToolCalls(left, options.preserveRecentMessages)) : allCalls;
  let decisions = calls.map((call) => (call.pinned ? { id: call.id, tool: call.tool, keepCall: 1, keepResult: 1, action: 'keep', reason: 'pinned' } : { ...decisionOf.get(call.tool_use_id), id: call.id }));

  // 3. What each dropped result held that looked like nothing else in it.
  const byId = new Map(calls.map((call) => [call.id, call]));
  const outputs = outputsById(left);
  const dropped = decisions.filter((d) => d.action !== 'keep').map((d) => byId.get(d.id));
  const texts = dropped.map((call) => outputs.get(call.tool_use_id) ?? '');
  const { picked, chars: rescuedChars } = pickStandouts(texts, {
    budget: cfg.retainMaxChars ?? 6_000,
    skip: (i, line) => texts[i].slice(0, options.truncateHeadChars).includes(line),
  });
  const kept = new Map(dropped.flatMap((call, i) => (picked[i].length ? [[call.tool_use_id, picked[i]]] : [])));
  // A call whose output still holds needed lines is not dropped whole.
  decisions = decisions.map((d) => (d.action === 'drop_call' && kept.has(byId.get(d.id).tool_use_id) ? { ...d, action: 'drop_result', reason: 'result_dropped', rescued: true } : d));

  // 4. Rebuild. applyDecisions hands back fresh copies for what it truncated;
  // only those get the kept lines, so the engine's own objects stay untouched.
  const originals = new Set(left.flatMap((m) => [m, ...m.toolUses, ...(m.toolResults ?? [])]));
  const applied = applyDecisions(left, decisions, calls, options.truncateHeadChars);
  for (const message of applied) {
    if (originals.has(message)) continue;
    for (const item of [...message.toolUses, ...(message.toolResults ?? [])]) {
      if (originals.has(item) || !kept.has(item.tool_use_id)) continue;
      item.text = withKeptLines(outputs.get(item.tool_use_id) ?? '', kept.get(item.tool_use_id), options.truncateHeadChars);
    }
  }
  const cutInputs = new Set(decisions.filter((d) => d.action === 'drop_result').map((d) => byId.get(d.id).tool_use_id));
  const cut = { inputs: 0 };
  const out = withoutThinking(applied, cutInputs, cut).map((m) => {
    const lines = notes.get(m);
    if (!lines) return m;
    const noted = { role: m.role, text: `${lines.join('\n')}\n\n${m.text}`, toolUses: m.toolUses };
    if (m.toolResults) noted.toolResults = m.toolResults;
    return noted;
  });
  const charsAfter = out.reduce((sum, m) => sum + messageChars(m), 0);
  const reduction = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
  return {
    stage: reduction >= (cfg.compactMinReduction ?? MIN_REDUCTION) ? 'compacted' : 'below_min',
    messages: out,
    decisions,
    topics: topics.map((t) => ({ ...t, p: topicP.get(t.id), dropped: gone.includes(t) })),
    stats: {
      ...base,
      charsAfter,
      reduction: Math.round(reduction * 1000) / 1000,
      messagesBefore: messages.length,
      messagesAfter: out.length,
      kept: count(decisions, 'keep'),
      resultsDropped: count(decisions, 'drop_result'),
      callsDropped: count(decisions, 'drop_call'),
      pinned: decisions.filter((d) => d.reason === 'pinned').length,
      unpinnedRecent: allCalls.filter((c, i) => !c.pinned && collectedPinned[i]).length,
      inputsCut: cut.inputs,
      rescuedResults: kept.size,
      rescuedLines: [...kept.values()].reduce((n, lines) => n + lines.length, 0),
      rescuedChars,
      callsAsked: candidates.length,
      callsTooSmall: small.size,
      topicsAsked: topics.length,
      topicsTooSmall: exchanges.length - topics.length,
      topicsDropped: gone.length,
      topicP: topics.map((t) => Math.round((topicP.get(t.id) ?? 1) * 100) / 100),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      jevRequests: jev.counter?.requests,
      ms: Date.now() - started,
    },
  };
}
