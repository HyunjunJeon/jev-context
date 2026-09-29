import { buildJevRequest, parseJevResponse } from '../../vendor/jev-pruner/dist/jev.js';

/**
 * A JevAsker for jev-pruner and for this plugin's own questions. `simulated`
 * is for tests and rehearsals only: fixed scores from a regex, never Jev.
 */
export function asker(cfg, counter = { requests: 0 }) {
  if (cfg.jev === 'simulated') {
    const needed = /error|warn|fail|BUNDLE|ROLLBACK|completed|sha256|digest|rollback|release/i;
    return {
      counter,
      async ask(state, questions) {
        counter.requests += 1;
        const answers = {};
        for (const id of Object.keys(questions)) {
          // Verbatim compaction's call-level pair: keep every call, drop every result.
          if (id.startsWith('call_') || id.startsWith('result_')) {
            answers[id] = { type: 'noul', noul: id.startsWith('call_') ? 0.99 : 0.01 };
            continue;
          }
          const text = state.chunks?.find((chunk) => chunk.id === id)?.text ?? '';
          answers[id] = { type: 'noul', noul: needed.test(text) ? 0.99 : 0.01 };
        }
        return { answers };
      },
    };
  }
  if (cfg.jev !== 'live' || !cfg.apiKey) return null;
  return {
    counter,
    async ask(state, questions) {
      counter.requests += 1;
      const request = buildJevRequest({ apiKey: cfg.apiKey, model: cfg.jevModel }, state, questions);
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(20_000),
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}
