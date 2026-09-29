import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Each library is pinned to the commit this plugin was checked against.
//   jev-pruner: the Jev client, the chunk-level trimmer and its retention rules.
//   fast-jev-compaction: call-level keep/drop decisions for verbatim compaction.
const LIBRARIES = [
  { name: 'jev-pruner', pinned: '070d4af', source: process.env.JEV_PRUNER_REPO ?? 'https://github.com/tamaratran/jev-pruner.git' },
  { name: 'fast-jev-compaction', pinned: 'e3f262a', source: process.env.FAST_JEV_REPO ?? 'https://github.com/tamaratran/fast-jev-compaction.git' },
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const { name, pinned, source } of LIBRARIES) {
  const dir = resolve(import.meta.dirname, '../vendor', name);
  if (!existsSync(dir)) run('git', ['clone', '--quiet', source, dir]);
  run('git', ['-C', dir, 'checkout', '--quiet', pinned]);
  run('npm', ['--prefix', dir, 'ci', '--silent']);
  run('npm', ['--prefix', dir, 'run', 'build', '--silent']);
  console.log(`${name} ${pinned} built at ${dir}`);
}
