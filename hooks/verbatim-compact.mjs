// Claude Code function hook (early access: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
// With JEV_CONTEXT_COMPACT=verbatim it answers `session.compact` with the
// verbatim compaction (src/core/verbatim.mjs) instead of a summary. Answering
// without next() means core never runs, so the command PreCompact/SessionStart
// hooks stay out of it. When Jev fails or the history shrinks too little it
// passes on: the built-in summary runs, and with it the retain hooks.
// The worker has no Node: settings come from $.env, the log goes through $.fs.
import { buildJevRequest, parseJevResponse } from '../vendor/jev-pruner/dist/jev.js';
import { asker } from '../src/core/jev.mjs';
import { compactVerbatim, MIN_REDUCTION } from '../src/core/verbatim.mjs';

const JEV_TIMEOUT_MS = 20_000;
const TIMED_OUT = Symbol('timed out');

// $.env.get takes literal names only (Claude Code lists what a module reads).
async function settings($) {
  const number = (value, fallback) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);
  const apiKey = await $.env.get('TYPESAFE_API_KEY');
  return {
    compact: (await $.env.get('JEV_CONTEXT_COMPACT')) || 'summary',
    // Same defaults as src/core/config.mjs: live whenever a key is in the shell.
    jev: (await $.env.get('JEV_CONTEXT_JEV')) || (apiKey ? 'live' : 'off'),
    jevModel: (await $.env.get('JEV_CONTEXT_JEV_MODEL')) || 'jev-latest',
    retainMaxChars: number(await $.env.get('JEV_CONTEXT_RETAIN_MAX_CHARS'), 6_000),
    compactMinReduction: number(await $.env.get('JEV_CONTEXT_COMPACT_MIN_REDUCTION'), MIN_REDUCTION),
    compactTopics: (await $.env.get('JEV_CONTEXT_COMPACT_TOPICS')) || 'on',
    compactKeep: number(await $.env.get('JEV_CONTEXT_COMPACT_KEEP'), 0.3),
    compactTopicDrop: number(await $.env.get('JEV_CONTEXT_COMPACT_TOPIC_DROP'), 0.8),
    log: (await $.env.get('JEV_CONTEXT_LOG')) || `${$.plugin.root}/logs/decisions.jsonl`,
    apiKey,
  };
}

/** A Jev asker over the host's fetch (the worker has no network of its own). */
function jevFor($, cfg) {
  if (cfg.jev === 'simulated') return asker(cfg);
  if (cfg.jev !== 'live' || !cfg.apiKey) return null;
  const counter = { requests: 0 };
  return {
    counter,
    async ask(state, questions) {
      counter.requests += 1;
      const request = buildJevRequest({ apiKey: cfg.apiKey, model: cfg.jevModel }, state, questions);
      // The losing timer resolves later to nothing; a rejecting one would go unhandled.
      const timeout = $.clock.sleep(JEV_TIMEOUT_MS).then(() => TIMED_OUT);
      const response = await Promise.race([$.http.fetch(request.url, { method: request.method, headers: request.headers, body: request.body }), timeout]);
      if (response === TIMED_OUT) throw new Error('Jev timed out');
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

/** Same line format as bin/hook.mjs. $.fs writes whole files, so this appends by rewriting. */
async function log($, cfg, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), host: 'claude', hook: 'session-compact', ...entry });
  $.ui.log(`jev-context ${line}`);
  try {
    const before = (await $.fs.exists(cfg.log)) ? await $.fs.read(cfg.log) : '';
    await $.fs.write(cfg.log, `${before}${line}\n`);
  } catch {
    // Logging never changes the compaction.
  }
}

export const register = (on) => {
  on('session.compact', async ($, e, next) => {
    const cfg = await settings($);
    if (cfg.compact !== 'verbatim') return next(e);
    const started = Date.now();
    const entry = { trigger: e.trigger, session: await $.session.id().catch(() => undefined) };
    // An ahead-of-time summary would be installed without asking this hook
    // again; skipping it keeps the real compaction on this path.
    if (e.trigger === 'precompute') return { skip: 'jev-context: verbatim compaction runs at compaction time' };
    if (e.agentId) {
      await log($, cfg, { ...entry, decision: 'subagent_passed' });
      return next(e);
    }
    const jev = jevFor($, cfg);
    if (!jev) {
      await log($, cfg, { ...entry, decision: 'fallback_no_jev' });
      return next(e);
    }
    try {
      const result = await compactVerbatim(cfg, e.messages, jev, { goal: e.instructions ?? '' });
      Object.assign(entry, result.stats, { elapsedMs: Date.now() - started });
      if (result.stage !== 'compacted') {
        await log($, cfg, { ...entry, decision: `fallback_${result.stage}` });
        return next(e);
      }
      await log($, cfg, { ...entry, decision: 'compacted' });
      return { messages: result.messages };
    } catch (error) {
      await log($, cfg, { ...entry, decision: 'fallback_error', error: String(error?.message ?? error).slice(0, 200), jevRequests: jev.counter?.requests, elapsedMs: Date.now() - started });
      return next(e);
    }
  });
};
