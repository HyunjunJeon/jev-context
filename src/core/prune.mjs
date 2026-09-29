// Shrinks one tool output as it enters the conversation. Decided once, then
// frozen: the result is what the transcript keeps, so the cached prefix and
// later thinking blocks never see it change.
import { classifyOutput, exceedsOutputThreshold, looksBinary, trimOutput } from '../../vendor/jev-pruner/dist/output.js';
import { looksSecret } from '../../vendor/jev-pruner/dist/secrets.js';
import { asker } from './jev.mjs';
import { reduceOutput } from './reduce.mjs';

const VISIBLE_CHARS_PER_REQUEST = 192;
const LISTING = /^(?:ls|tree|du|find|fd|rg|grep|egrep|fgrep|git\s+(?:grep|ls-files|status|log))\b/;
const MAX_SCORING_REQUESTS = 11;

const footer = (folded, path) => (path
  ? `\n[jev-context: ${folded} lines folded; full output: ${path}]`
  : `\n[jev-context: ${folded} lines folded; not saved, re-run the command for them]`);

/**
 * `budget` caps what the model may see (Claude Code's own preview size for an
 * output it saved to a file). `archivePath` is where the full output is, or
 * will be once `saveOriginal()` (absent when the host already saved it)
 * returns true. Returns `{ text, stage, ... }`, or `{ text: null, stage }` to
 * leave the output as it is. `context()` (goal and conversation) is read only
 * when Jev is asked.
 */
export async function pruneOutput(cfg, { command, output, context = () => ({ goal: '', messages: [] }), budget = Infinity, archivePath, saveOriginal }) {
  const result = { text: null, stage: 'small', sourceChars: output.length };
  if (output.length < cfg.pruneMinChars) return result;
  result.stage = 'binary';
  if (looksBinary(output)) return result;
  result.stage = 'document';
  const category = classifyOutput(command, output);
  if (category === 'document') return result;

  // A secret-looking output is neither saved nor cited (jev-pruner's rule).
  const secret = looksSecret(command, output);
  const path = secret ? null : archivePath;
  const candidates = [];
  // A search or a listing is what the agent asked to see: similar-looking
  // matches are not noise, so only Jev (with jev-pruner's search guidance) may
  // trim it.
  const searching = category === 'search' || LISTING.test(command.trim());
  const { text: reduced, folded } = searching ? { text: output, folded: 0 } : reduceOutput(output);
  if (folded > 0) candidates.push({ stage: 'fold', body: reduced, folded });

  const foldFits = folded > 0 && (reduced + footer(folded, path)).length <= Math.min(budget, output.length * (1 - cfg.pruneMinSaving));
  const counter = { requests: 0 };
  // Jev only where the rules could not do the job, and only when enabled:
  // on real logs whose noise does not announce itself its keep scores sat
  // just above the drop line (median 0.11) and nothing was trimmed.
  const jev = foldFits || cfg.pruneJev !== 'on' ? null : asker(cfg, counter);
  if (jev && exceedsOutputThreshold(output)) {
    const cap = Number.isFinite(budget) ? budget : cfg.pruneMaxChars;
    const { goal, messages } = context();
    const trimmed = await trimOutput(
      { command, goal, messages, output, fullOutputPath: path ?? undefined },
      jev,
      {
        compactMarkers: true,
        maxChars: cap,
        maxScoringRequests: Math.min(MAX_SCORING_REQUESTS, Math.ceil(cap / VISIBLE_CHARS_PER_REQUEST) - 1),
        onDecision: (reason) => { result.jevDecision = reason; },
      },
    ).catch((error) => {
      result.jevError = String(error?.message ?? error).slice(0, 200);
      return null;
    });
    if (trimmed?.trimmed) candidates.push({ stage: 'jev', body: trimmed.output, jevOwnFooter: true });
    result.jevRequests = counter.requests;
  }

  const usable = candidates
    .map((c) => ({ ...c, text: c.jevOwnFooter ? c.body : c.body + footer(c.folded, path) }))
    .filter((c) => c.text.length <= budget && c.text.length <= output.length * (1 - cfg.pruneMinSaving))
    .sort((a, b) => a.text.length - b.text.length);
  result.stage = candidates.length === 0 ? 'nothing_to_fold' : 'not_enough_saving';
  const best = usable[0];
  if (!best) return result;
  // The original must be recoverable before anything is hidden.
  if (path && saveOriginal && !saveOriginal(output)) {
    result.stage = 'archive_failed';
    return result;
  }
  const { text } = best;
  return { ...result, text, stage: best.stage, visibleChars: text.length };
}
