// Writes <project>/.codex/hooks.json for a Codex test run: the plugin's
// codex/hooks.json with its path filled in, optionally plus an observation
// hook on every event. The user's ~/.codex stays untouched.
//   node scripts/codex-project-hooks.mjs <project-dir> [--dump]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/codex-project-hooks.mjs <project-dir> [--dump]');
  process.exit(2);
}
const hooks = JSON.parse(readFileSync(join(root, 'codex/hooks.json'), 'utf8').replaceAll('${PLUGIN_ROOT}', root));
if (process.argv.includes('--dump')) {
  const dump = { type: 'command', command: `node "${join(root, 'scripts/hook-dump.mjs')}"`, timeout: 10 };
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop']) {
    hooks.hooks[event] = [...(hooks.hooks[event] ?? []), { hooks: [dump] }];
  }
}
const dir = join(resolve(target), '.codex');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'hooks.json');
if (existsSync(file)) console.error(`overwriting ${file}`);
writeFileSync(file, JSON.stringify(hooks, null, 2));
console.log(`wrote ${file}: ${Object.keys(hooks.hooks).join(', ')}`);
