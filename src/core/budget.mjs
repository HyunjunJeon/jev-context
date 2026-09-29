// How much detail should a worker's report carry back to the coordinator?
// Judged from the brief alone - it is in the state and it is prose rules
// cannot read - and turned into a report budget. The worker writes to it; the
// full report is always kept in a file.
import { asker } from './jev.mjs';

export const LEVELS = {
  conclusion: {
    budget: 1_200,
    criterion: 'The coordinator only needs the outcome: what was done or found, commit ids, test or CI status, and anything blocking. The details can stay in a saved file.',
  },
  key_details: {
    budget: 3_000,
    criterion: 'The coordinator needs the outcome plus the key specifics it must act on or pass to another agent: findings, decisions, numbers, file paths.',
  },
  full: {
    budget: null,
    criterion: 'The coordinator needs the full detail in the report, because it will review, merge or relay the content itself.',
  },
};
const RANK = { conclusion: 0, key_details: 1, full: 2 };

export const LEVEL_QUESTION = 'The `brief` is what a coordinator asked a worker agent to do. When the worker reports back, how much detail will the coordinator need in the report itself? Anything left out stays in a saved file the coordinator can open.';

export async function chooseLevel(cfg, { brief, originalBrief }) {
  const counter = { requests: 0 };
  const jev = asker(cfg, counter);
  if (!jev) return { skipped: 'no_jev' };
  const state = { brief: brief.slice(0, 6000) };
  if (originalBrief) state.original_task = originalBrief.slice(0, 2000);
  const criteria = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, v.criterion]));
  const { answers } = await jev.ask(state, { report_detail: { type: 'choice', instructions: LEVEL_QUESTION, criteria } });
  const a = answers.report_detail;
  if (!a || !(a.choice in LEVELS)) throw new Error('Invalid Jev answer for report_detail');
  const probabilities = a.probabilities ?? { [a.choice]: 1 };
  const expected = Object.entries(probabilities).reduce((s, [k, p]) => s + (RANK[k] ?? 0) * p, 0);
  return { level: a.choice, confidence: a.confidence, probabilities, expected, budget: LEVELS[a.choice].budget, requests: counter.requests };
}
