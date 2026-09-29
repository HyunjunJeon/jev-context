// Summarizes a Codex rollout for the jev-context tests: what entered the
// session (tool outputs, subagent results), compactions, and token counts.
// Prints sizes only, never content.
//   node scripts/codex-rollout-stats.mjs [rollout.jsonl]   (default: the newest rollout)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function newestRollout() {
  const base = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  let best = null;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && (!best || st.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: st.mtimeMs };
    }
  };
  walk(base);
  return best?.path;
}

const file = process.argv[2] ?? newestRollout();
if (!file) {
  console.error('No rollout found.');
  process.exit(2);
}
const text = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b.text ?? '').join('') : JSON.stringify(content ?? ''));
const stats = { toolOutputs: 0, toolOutputChars: 0, subagentResults: [], compactions: 0, lastTokens: null, spawns: 0 };
for (const line of readFileSync(file, 'utf8').split('\n')) {
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  const p = e.payload ?? {};
  if (e.type === 'compacted' || p.type === 'compacted' || p.type === 'context_compacted') stats.compactions += 1;
  if (e.type !== 'response_item' && p.type !== 'token_count') continue;
  if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) {
    stats.toolOutputs += 1;
    stats.toolOutputChars += text(p.output).length;
  }
  if (['function_call', 'custom_tool_call'].includes(p.type) && /spawn_agent/.test(p.name ?? '')) stats.spawns += 1;
  // A subagent's result arrives in the parent as an agent_message it did not author.
  if (p.type === 'agent_message' && p.recipient && p.author !== p.recipient) stats.subagentResults.push({ from: p.author, chars: text(p.content).length });
  if (p.type === 'token_count' && p.info?.last_token_usage) stats.lastTokens = p.info.last_token_usage;
}
console.log(`rollout: ${file}`);
console.log(`tool outputs: ${stats.toolOutputs} (${stats.toolOutputChars.toLocaleString()} chars) | subagents spawned: ${stats.spawns} | compactions: ${stats.compactions}`);
for (const r of stats.subagentResults) console.log(`subagent result from ${r.from}: ${r.chars.toLocaleString()} chars`);
if (stats.lastTokens) console.log(`last request tokens: input ${stats.lastTokens.input_tokens}, cached ${stats.lastTokens.cached_input_tokens}, output ${stats.lastTokens.output_tokens}`);
