#!/usr/bin/env node
// One entry point for every hook: `node bin/hook.mjs <claude|codex> <event>`.
// A hook never fails its host: any error is logged and the event passes.
import { config } from '../src/core/config.mjs';
import { log, readStdin } from '../src/core/io.mjs';
import { postToolUse } from '../src/handlers/prune.mjs';
import { readGate } from '../src/handlers/readgate.mjs';
import { handback, spawnGuidance, subagentStop } from '../src/handlers/report.mjs';
import { injectAfterCompact, preCompact } from '../src/handlers/retain.mjs';
import { onPrompt, onResume } from '../src/handlers/timing.mjs';
import { wrapCommand } from '../src/handlers/wrap.mjs';

const [host, name] = process.argv.slice(2);
const handlers = {
  'post-tool-use': (cfg, e) => postToolUse(cfg, e),
  'pre-tool-use': async (cfg, e) => {
    if (e.tool_name === 'SubagentHandback') return handback(cfg, e);
    if (host === 'claude' && (e.tool_name === 'Agent' || e.tool_name === 'Task')) return spawnGuidance(cfg, e);
    // A read turned back is never wrapped; one let through may still be.
    const gate = await readGate(cfg, e, host);
    if (gate.output || host !== 'codex') return gate;
    const wrap = wrapCommand(cfg, e);
    return { ...wrap, entry: { ...wrap.entry, readGate: gate.entry.decision } };
  },
  'subagent-stop': (cfg, e) => subagentStop(cfg, e, host),
  'pre-compact': (cfg, e) => preCompact(cfg, e, host),
  'session-start': (cfg, e) => {
    if (e.source === 'compact') return injectAfterCompact(cfg, e);
    if (host === 'claude' && (e.source === 'resume' || e.source === 'fork')) return onResume(cfg, e);
    return { entry: { decision: 'not_applicable', source: e.source } };
  },
  'user-prompt-submit': (cfg, e) => (host === 'claude' ? onPrompt(cfg, e) : { entry: { decision: 'not_applicable' } }),
};

const cfg = config();
const started = Date.now();
let event = {};
let entry = { decision: 'unknown_event' };
try {
  event = await readStdin();
  const handler = handlers[name];
  if (handler) {
    const result = await handler(cfg, event);
    entry = result.entry;
    if (result.output) process.stdout.write(JSON.stringify(result.output));
  }
} catch (error) {
  entry = { decision: 'hook_error', error: String(error?.message ?? error).slice(0, 200) };
} finally {
  log(cfg, { host, hook: name, session: event.session_id, ...entry, elapsedMs: Date.now() - started });
}
