import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/core/config.mjs';

const cfg = config();
const version = (cmd) => {
  const run = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
};
const checks = {
  node: process.versions.node,
  claude: version('claude'),
  codex: version('codex'),
  vendor: {
    'jev-pruner': existsSync(resolve(cfg.root, 'vendor/jev-pruner/dist/index.js')),
    'fast-jev-compaction': existsSync(resolve(cfg.root, 'vendor/fast-jev-compaction/dist/compact.js')),
  },
  jev: cfg.jev,
  apiKeySet: Boolean(cfg.apiKey),
  modules: { prune: cfg.prune, report: `${cfg.reportMaxChars} chars`, retain: cfg.retain, compact: cfg.compact, compactTopics: cfg.compactTopics, resume: cfg.resume, idle: cfg.idle, codexWrap: cfg.codexWrap },
  // verbatim compaction runs as a Claude Code function hook, which needs this flag.
  functionHooks: process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1',
  log: cfg.log,
};
console.log(JSON.stringify(checks, null, 2));
if (!Object.values(checks.vendor).every(Boolean)) {
  console.error('vendor/ is not built: run `npm run setup`.');
  process.exitCode = 1;
}
if (cfg.jev === 'live' && !checks.apiKeySet) console.error('JEV_CONTEXT_JEV=live needs TYPESAFE_API_KEY; Jev calls will be skipped.');
if (cfg.jev === 'off' && checks.apiKeySet) console.error('TYPESAFE_API_KEY is set but Jev is explicitly off by default; set JEV_CONTEXT_JEV=live to opt in.');
if (cfg.jev !== 'live') console.log('Jev is off: set TYPESAFE_API_KEY in the shell (JEV_CONTEXT_JEV=off keeps it off with a key).');
if (cfg.compact === 'verbatim' && !checks.functionHooks) console.log('Compaction: verbatim is the default, but Claude Code runs it only with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1; until then the built-in summary (with retain) runs.');
