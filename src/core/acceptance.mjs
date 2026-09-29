// Acceptance check for a subagent's report, before it reaches the
// orchestrator: does it deliver what the brief asked (item by item), and, for
// development work, does it show how the work was verified? Jev cannot judge
// whether the work is correct, and is not asked to.
import { noulAnswer } from '../../vendor/jev-pruner/dist/jev.js';
import { asker } from './jev.mjs';

const MAX_ITEMS = 8;

/** The brief's enumerated requests: numbered items first, else a short bullet list. */
export function extractItems(brief) {
  const lines = brief.split('\n');
  const numbered = lines.map((l) => l.match(/^\s*(?:\d{1,2}[.)]|\(\d{1,2}\)|[①-⑩])\s+(.{10,240})$/)?.[1]).filter(Boolean);
  if (numbered.length >= 2) return numbered.length <= MAX_ITEMS ? numbered : [];
  const bullets = lines.map((l) => l.match(/^\s*[-*•]\s+(.{10,240})$/)?.[1]).filter(Boolean);
  return bullets.length >= 2 && bullets.length <= MAX_ITEMS ? bullets : [];
}

/** Development work: code paths plus build/test/commit vocabulary. */
export function isDevelopment(brief) {
  const signals = [
    /\.(?:py|ts|tsx|js|mjs|cjs|go|rs|java|kt|rb|sh|toml|ya?ml|json|sql)\b/,
    /\b(?:commit|tests?|TDD|fix|implement|refactor|CI|build|lint)\b/i,
    /구현|수정|테스트|커밋|리팩터|빌드/,
  ];
  return signals.filter((re) => re.test(brief)).length >= 2;
}

export const ON_TARGET = 'The `report` is a subagent\'s final report to the coordinator who wrote the `brief`. Does the report deliver what the brief asks for, or state plainly which parts were not done and why? Judge coverage of the requests only, not whether the work itself is correct.';
export const EVIDENCE = 'This was a development task. Does the report show how the work was verified - tests or commands run with their results, CI status, or the commits and files changed - rather than only asserting that it works?';
const itemQuestion = (item) => `Does the report address this request from the brief - delivering it or stating that it was not done: "${item}"?`;

/** One Jev request; returns the scores and the items they refer to. */
export async function scoreReport(cfg, { brief, originalBrief, report }) {
  const counter = { requests: 0 };
  const jev = asker(cfg, counter);
  if (!jev) return { skipped: 'no_jev' };
  const items = extractItems(brief);
  const development = isDevelopment(`${originalBrief ?? ''}\n${brief}`);
  const questions = { on_target: { type: 'noul', instructions: ON_TARGET } };
  items.forEach((item, i) => { questions[`item_${i + 1}`] = { type: 'noul', instructions: itemQuestion(item) }; });
  if (development) questions.evidence = { type: 'noul', instructions: EVIDENCE };
  const state = { brief: brief.slice(0, 6000), report: report.slice(0, 8000) };
  if (originalBrief) state.original_brief = originalBrief.slice(0, 2000);
  const { answers } = await jev.ask(state, questions);
  const itemScores = items.map((_, i) => noulAnswer(answers, `item_${i + 1}`));
  return {
    onTarget: noulAnswer(answers, 'on_target'),
    items,
    itemScores,
    evidence: development ? noulAnswer(answers, 'evidence') : null,
    development,
    requests: counter.requests,
  };
}
