// Builds the folder to install from: what the hooks run, both hosts'
// manifests, and the vendored libraries' built output with their licences.
// A local marketplace copies its folder as it is (no .gitignore), so
// installing this repository directly would also copy node_modules and logs/,
// which holds evaluation data taken from real sessions.
//   npm run package [out]   (default: package/jev-context, a marketplace root for both hosts)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(root, 'package/jev-context'));
const FILES = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
  'bin',
  'src',
  'hooks/hooks.json',
  'hooks/verbatim-compact.mjs',
  'codex',
  'scripts/doctor.mjs',
  'README.md',
];
const VENDOR = ['jev-pruner', 'fast-jev-compaction'];

for (const name of VENDOR) {
  if (!existsSync(join(root, 'vendor', name, 'dist'))) {
    console.error(`vendor/${name} is not built: run \`npm run setup\` first.`);
    process.exit(1);
  }
}
rmSync(out, { recursive: true, force: true });
const copy = (from, to = from) => {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(join(root, from), join(out, to), { recursive: true });
};
for (const path of FILES) copy(path);
for (const name of VENDOR) for (const part of ['dist', 'package.json', 'LICENSE']) copy(join('vendor', name, part));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  description: pkg.description,
  license: pkg.license,
  engines: pkg.engines,
  scripts: { doctor: 'node scripts/doctor.mjs' },
}, null, 2)}\n`);
console.log(`packaged ${pkg.name} ${pkg.version} at ${out}`);
