// The settle.ts fixture the compaction e2e scripts read and quote. Its lines
// are irregular (fixed seed): a summary cannot rebuild a neighbour from a
// pattern. The first version was `stepN … timeoutMs: 1000+N`, and the
// built-in summary quoted five lines by restating that formula.
let seed = 20260929;
const pick = (xs) => xs[((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) % xs.length];

export const SETTLE = Array.from({ length: 60 }, (_, i) => (i === 30
  ? '  if (attempt.idempotencyKey && seen.has(attempt.idempotencyKey)) return seen.get(attempt.idempotencyKey);'
  : `  const ${pick(['fee', 'hold', 'fx', 'net', 'tax', 'cap', 'adj', 'rev'])}${pick(['Leg', 'Part', 'Row', 'Slot'])}${i} = await ledger.${pick(['apply', 'post', 'capture', 'reserve', 'settleLeg'])}(batch[${pick([3, 7, 11, 13, 17, 19, 23, 29])}], { retry: ${pick(['policy.retry', 'false', '2', 'policy.retry && !dryRun'])}, timeoutMs: ${pick([750, 1200, 2750, 3100, 4400, 900, 1650])} });`));
export const GUARD = SETTLE[30].trim();
/** The guard with two lines on each side, trimmed. */
export const BLOCK = SETTLE.slice(28, 33).map((l) => l.trim());
export const settleSource = () => `export async function settle(batch, policy, seen, attempt) {\n${SETTLE.join('\n')}\n}\n`;
