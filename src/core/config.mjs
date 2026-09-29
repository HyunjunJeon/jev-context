import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

function read(name, fallback) {
  const value = process.env[`JEV_CONTEXT_${name}`];
  if (value === undefined || value === '') return fallback;
  if (typeof fallback === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  return value;
}

/** Every knob, read once per hook process. Env vars only: no key or setting lives in a file. */
export function config() {
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
  return {
    root,
    apiKey: process.env.TYPESAFE_API_KEY,
    // Jev is on whenever a key is in the shell (the user's choice, 2026-09-29),
    // so conversation parts go to TypeSafe by default; JEV_CONTEXT_JEV=off stops
    // all of it. Each call site still asks only when a rule cannot decide and
    // the answer can change the outcome (README: where Jev is asked).
    jev: read('JEV', hasKey ? 'live' : 'off'), // live | simulated | off
    jevModel: read('JEV_MODEL', 'jev-latest'),
    prune: read('PRUNE', 'on'),
    pruneMinChars: read('PRUNE_MIN_CHARS', 4_000),
    pruneMinSaving: read('PRUNE_MIN_SAVING', 0.25),
    pruneMaxChars: read('PRUNE_MAX_CHARS', 8_000),
    reportMaxChars: read('REPORT_MAX_CHARS', 3_000),
    reportSplit: read('REPORT_SPLIT', 'on'), // on: Summary/Details reports, only the Summary delivered
    reportSummaryChars: read('REPORT_SUMMARY_CHARS', 1_500),
    // on: standout lines by rule + outputs the next step works on, carried whole
    // (Jev, once per compaction) | rules: standout lines only | hybrid | jev | off
    retain: read('RETAIN', 'on'),
    retainMaxChars: read('RETAIN_MAX_CHARS', 6_000),
    retainWholeMaxChars: read('RETAIN_WHOLE_MAX_CHARS', 12_000),
    // verbatim: Jev drops stale tool calls/results instead of a summary (Claude Code
    // function hook, hooks/verbatim-compact.mjs; reads these same env vars itself).
    // The host's own summary compacts by default, with retain beside it (no flag
    // needed). verbatim replaces the summary through a Claude Code function hook
    // and needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1.
    compact: read('COMPACT', 'summary'), // summary | verbatim
    compactMinReduction: read('COMPACT_MIN_REDUCTION', 0.25),
    compactTopics: read('COMPACT_TOPICS', 'on'), // on: verbatim also drops exchanges whose topic the user closed
    compactKeep: read('COMPACT_KEEP', 0.3), // verbatim keeps a result whole from this Jev score
    compactTopicDrop: read('COMPACT_TOPIC_DROP', 0.8), // and drops a closed topic from this one
    resume: read('RESUME', 'compact'), // compact | off  (Claude Code)
    idle: read('IDLE', 'block-once'), // block-once | warn | off  (Claude Code)
    compactMinTokens: read('COMPACT_MIN_TOKENS', 60_000),
    ttlSeconds: read('TTL_SECONDS', null),
    assumeExpiredAfter: read('ASSUME_EXPIRED_AFTER', Infinity),
    codexWrap: read('CODEX_WRAP', 'off'), // on | off
    readGate: read('READ_GATE', 'on'), // on | off  (needs Jev; orchestrator only)
    readGateLines: read('READ_GATE_LINES', 100),
    // Jev only where its answer is grounded in the state (see README: where Jev is asked).
    readGateIntent: read('READ_GATE_INTENT', 'on'), // on: ask only when the read's purpose is visible
    pruneJev: read('PRUNE_JEV', 'off'), // rules fold what they can; Jev's chunk judgment is opt-in
    log: read('LOG', resolve(root, 'logs/decisions.jsonl')),
    stateDir: read('STATE_DIR', resolve(root, '.state')),
  };
}
