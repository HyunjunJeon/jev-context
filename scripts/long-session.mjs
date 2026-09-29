// Long-session check of the Summary/Details split: one coordinator session
// delegates six reviews one after another, so reports pile up in its window.
// Records the coordinator's context after each report arrives (growth per
// delegation decides when compaction comes), what it received, whether it
// went back to saved details, and whether the final table is complete.
//   node scripts/long-session.mjs [arms]   (arms: off,on — default both)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const model = process.env.E2E_MODEL ?? 'sonnet';
const arms = (process.argv[2] ?? 'off,on').split(',');
const FILES = ['readgate.mjs', 'prune.mjs', 'reduce.mjs', 'retain.mjs', 'budget.mjs', 'acceptance.mjs'];
const PROMPT = `You coordinate a code review of six files in jev-context/src/core/: ${FILES.join(', ')}.
Review them ONE AT A TIME: for each file, use the Agent tool to start one subagent that reviews only that file in depth (bugs, edge cases, risky assumptions, each with line numbers) and reports back. Wait for its report before starting the next file. Never run two subagents at once.
After each report, write one line: the file and its most important problem.
When all six are done, give a final table with one row per file: file | most important problem | line number(s) | the fix you recommend.`;

function run(arm) {
  const work = mkdtempSync(join(tmpdir(), `jev-long-${arm}-`));
  mkdirSync(join(work, 'jev-context'));
  cpSync(join(root, 'src'), join(work, 'jev-context/src'), { recursive: true });
  const env = { ...process.env, JEV_CONTEXT_LOG: join(work, 'decisions.jsonl'), JEV_CONTEXT_STATE_DIR: join(work, 'state') };
  if (arm === 'off') Object.assign(env, { JEV_CONTEXT_REPORT_SPLIT: 'off', JEV_CONTEXT_REPORT_MAX_CHARS: '100000000' });
  const tools = ['Agent', 'Read', 'Grep', 'Glob', 'Bash(cat:*)', 'Bash(sed:*)', 'Bash(grep:*)', 'Bash(head:*)', 'Bash(wc:*)', 'Bash(nl:*)'];
  const started = Date.now();
  const r = spawnSync('claude', ['-p', PROMPT, '--model', model, '--plugin-dir', root, '--add-dir', join(homedir(), '.claude/projects'), '--allowedTools', ...tools, '--output-format', 'stream-json', '--verbose'], {
    cwd: work, input: '', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 3_000_000, env,
  });
  const events = r.stdout.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const session = events.find((e) => e.type === 'result')?.session_id;
  const transcript = join(homedir(), '.claude/projects', work.replace(/[/_]/g, '-'), `${session}.jsonl`);
  const timeline = [];
  let pending = null;
  let detailReads = 0;
  let finalText = '';
  if (session && existsSync(transcript)) {
    for (const line of readFileSync(transcript, 'utf8').split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.isSidechain) continue;
      const c = e.message?.content;
      const a = e.attachment;
      let arrived = 0;
      if (a?.type === 'queued_command' && String(a.prompt).includes('<agent-message')) arrived = String(a.prompt).length;
      if (e.type === 'user' && typeof c === 'string' && c.includes('<agent-message')) arrived = c.length;
      if (e.type === 'user' && typeof c === 'string' && c.includes('<task-notification>')) arrived = (c.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? '').length;
      if (arrived > 150) pending = { arrived };
      if (e.type === 'assistant' && e.message?.usage && e.message.model !== '<synthetic>') {
        const u = e.message.usage;
        const ctx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
        if (pending) { timeline.push({ reportChars: pending.arrived, contextAfter: ctx }); pending = null; }
        for (const b of c ?? []) {
          if (b.type === 'tool_use' && /report-\d+\.md/.test(JSON.stringify(b.input))) detailReads += 1;
          if (b.type === 'text') finalText = b.text;
        }
      }
    }
  }
  const result = events.find((e) => e.type === 'result');
  const rows = FILES.filter((f) => new RegExp(`\\|\\s*\`?${f.replace('.', '\\.')}`).test(finalText) || finalText.includes(f));
  return { arm, reports: timeline.length, timeline, detailReads, tableFiles: rows.length, cost: result?.total_cost_usd ?? 0, minutes: Math.round((Date.now() - started) / 60000), work };
}

for (const arm of arms) {
  const r = run(arm);
  console.log(JSON.stringify(r));
}
