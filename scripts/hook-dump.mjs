#!/usr/bin/env node
// Observation hook: writes each hook input (long strings shortened) to
// JEV_CONTEXT_DUMP_DIR so a test can see which events fire and with what
// fields. Answers nothing, so it never changes the session.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const dir = process.env.JEV_CONTEXT_DUMP_DIR ?? join(process.cwd(), '.jev-context', 'hook-dump');
try {
  const input = JSON.parse(raw || '{}');
  const shorten = (v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…[${v.length} chars]` : v);
  const out = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k2, v2]) => [k2, shorten(v2)])) : shorten(v)]));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${input.hook_event_name ?? 'event'}-${process.hrtime.bigint()}.json`), JSON.stringify(out, null, 1));
} catch {
  // Observation must never fail the host.
}
