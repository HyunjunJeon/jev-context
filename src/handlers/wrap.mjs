// Codex PreToolUse(Bash): Codex hooks cannot replace a shell tool's output, so
// a noisy command is rewritten to run through bin/codex-run.mjs, which prunes
// its stdout. Codex requires `permissionDecision: "allow"` with any
// `updatedInput`, so wrapping also approves the command: opt-in only.
import { resolve } from 'node:path';

// Build, test, install and lint commands: the output jev-pruner's rules and
// Jev's chunk questions were made for. Everything else runs untouched.
const NOISY = [
  /^(npm|pnpm|yarn|bun)\s+(?:(?:run\s+)?(?:build|test|lint|typecheck|check)(?::[\w-]+)*|install|ci|add)\b/,
  /^(make|gmake|ninja|pytest|jest|vitest|ctest|mvn|gradle|\.\/gradlew|tsc)\b/,
  /^(cargo|go)\s+(build|test|check|clippy|install)\b/,
  /^(pip3?|uv\s+pip)\s+install\b/,
  /^python3?\s+-m\s+(pytest|unittest|pip\s+install)\b/,
  /^docker\s+(build|compose\s+build)\b/,
];

export function wrapCommand(cfg, event) {
  const entry = { decision: 'off' };
  if (cfg.codexWrap !== 'on' || cfg.prune === 'off') return { entry };
  const input = event.tool_input ?? {};
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  entry.decision = 'not_noisy';
  if (!command || command.includes('codex-run.mjs')) return { entry };
  // updatedInput necessarily carries permissionDecision=allow in Codex. Never
  // auto-approve a shell program that chains, redirects, substitutes or pipes;
  // only one plain noisy command may be wrapped.
  if (/[|;&<>`$()\n\r]/.test(command)) {
    entry.decision = 'unsafe_shell_syntax';
    return { entry };
  }
  const simple = command.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*/, '');
  if (!NOISY.some((pattern) => pattern.test(simple))) return { entry };
  const runner = resolve(cfg.root, 'bin/codex-run.mjs');
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  const transcript = event.transcript_path ? ` --transcript ${JSON.stringify(event.transcript_path)}` : '';
  entry.decision = 'wrapped';
  return {
    entry,
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...input, command: `node ${JSON.stringify(runner)} --b64 ${encoded}${transcript}` },
      },
    },
  };
}
