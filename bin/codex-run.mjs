#!/usr/bin/env node
// Runs a command for Codex and prints its stdout through the prune pipeline.
// stderr passes through unchanged and the exit status is preserved, so the
// agent sees the same success or failure it would have seen unwrapped.
//   node codex-run.mjs [--transcript <rollout.jsonl>] --b64 <base64 command>
//   node codex-run.mjs [--transcript <rollout.jsonl>] -- <command ...>
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/core/config.mjs';
import { log, saveText } from '../src/core/io.mjs';
import { pruneOutput } from '../src/core/prune.mjs';
import { conversation } from '../src/transcript/codex.mjs';
import { goalOf } from '../src/transcript/claude.mjs';

const MAX_STDOUT = 8 * 1024 * 1024;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const rest = args.indexOf('--');
const command = rest !== -1 ? args.slice(rest + 1).join(' ') : Buffer.from(flag('--b64') ?? '', 'base64').toString('utf8');
if (!command) {
  console.error('codex-run: give the command as --b64 <base64> or after --');
  process.exit(2);
}

const cfg = config();
const child = spawn('/bin/bash', ['-lc', command], { stdio: ['inherit', 'pipe', 'inherit'] });
const chunks = [];
let size = 0;
let overflow = false;
child.stdout.on('data', (chunk) => {
  if (overflow) return process.stdout.write(chunk);
  size += chunk.length;
  if (size > MAX_STDOUT) {
    // Too large to hold: give up pruning and stream the rest untouched.
    overflow = true;
    for (const held of chunks) process.stdout.write(held);
    chunks.length = 0;
    return process.stdout.write(chunk);
  }
  chunks.push(chunk);
  return undefined;
});

child.on('close', async (code, signal) => {
  const status = code ?? 128 + (constants.signals[signal] ?? 1);
  if (overflow) return process.exit(status);
  const output = Buffer.concat(chunks).toString('utf8');
  const entry = { host: 'codex', hook: 'codex-run', decision: 'passed', exitCode: status, sourceChars: output.length };
  let text = null;
  try {
    const id = createHash('sha256').update(`${Date.now()}:${command}`).digest('hex').slice(0, 16);
    const archivePath = join(process.cwd(), '.jev-context', 'outputs', `${id}.txt`);
    const transcript = flag('--transcript');
    const result = await pruneOutput(cfg, {
      command,
      output,
      context: () => {
        const { messages } = conversation(transcript);
        return { goal: goalOf(messages), messages };
      },
      archivePath,
      saveOriginal: (full) => {
        try {
          saveText(archivePath, full);
          return true;
        } catch {
          // A read-only sandbox: without an archive nothing is hidden.
          return false;
        }
      },
    });
    Object.assign(entry, { decision: result.stage, visibleChars: result.visibleChars, jevRequests: result.jevRequests });
    text = result.text;
  } catch (error) {
    entry.decision = 'runner_error';
    entry.error = String(error?.message ?? error).slice(0, 200);
  }
  log(cfg, entry);
  process.stdout.write(text ?? output);
  return process.exit(status);
});
