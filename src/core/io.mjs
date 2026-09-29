import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text ? JSON.parse(text) : {};
}

/** One decision per line; never a key, a prompt or tool output. */
export function log(cfg, entry) {
  try {
    mkdirSync(dirname(cfg.log), { recursive: true });
    appendFileSync(cfg.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Logging never changes a hook's answer.
  }
}

const statePath = (cfg, key) => resolve(cfg.stateDir, `${String(key).replace(/[^\w.-]/g, '_')}.json`);

export function readState(cfg, key) {
  try {
    return JSON.parse(readFileSync(statePath(cfg, key), 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(cfg, key, state) {
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(statePath(cfg, key), JSON.stringify(state));
}

export function clearState(cfg, key) {
  rmSync(statePath(cfg, key), { force: true });
}

export function saveText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export const duration = (seconds) => (seconds < 120 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)}min`);
export const kTokens = (tokens) => `${Math.round(tokens / 1000)}k`;
