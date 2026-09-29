import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../src/core/config.mjs';
import { pruneOutput } from '../src/core/prune.mjs';
import { reduceOutput } from '../src/core/reduce.mjs';
import { hybridFacts, renderFacts, selectFacts } from '../src/core/retain.mjs';
import { cfgFor, labeledLog, neutralLog, tmp } from './helpers.mjs';

test('Jev is on whenever a key is in the shell; JEV_CONTEXT_JEV=off turns it off', () => {
  const beforeKey = process.env.TYPESAFE_API_KEY;
  const beforeMode = process.env.JEV_CONTEXT_JEV;
  try {
    delete process.env.JEV_CONTEXT_JEV;
    delete process.env.TYPESAFE_API_KEY;
    assert.equal(config().jev, 'off', 'no key, nothing to send with');
    process.env.TYPESAFE_API_KEY = 'test-key-never-sent';
    assert.equal(config().jev, 'live');
    process.env.JEV_CONTEXT_JEV = 'off';
    assert.equal(config().jev, 'off');
    delete process.env.JEV_CONTEXT_JEV;
    assert.equal(config().compact, 'summary', 'the built-in summary compacts by default');
    assert.equal(config().compactTopics, 'on');
  } finally {
    if (beforeKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = beforeKey;
    if (beforeMode === undefined) delete process.env.JEV_CONTEXT_JEV;
    else process.env.JEV_CONTEXT_JEV = beforeMode;
  }
});

test('folding keeps every line that differs from its neighbours', () => {
  for (const log of [labeledLog(), neutralLog()]) {
    const { text, folded } = reduceOutput(log);
    assert.ok(folded > 1700, `folded ${folded}`);
    assert.match(text, /sha256:7e4c9a/);
    assert.match(text, /stable-snapshot/);
    assert.match(text, /Build completed/);
    assert.ok(text.length < log.length / 20, `${text.length} chars`);
  }
});

test('folding never touches a diagnostic line, and cleans terminal noise', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `compiling module ${i} of 30`);
  lines.splice(15, 0, 'ERROR: module 15 failed to compile');
  const { text } = reduceOutput(`\x1b[32m${lines.join('\n')}\x1b[0m\nDownloading 10%\rDownloading 55%\rDownloading 100%\n\n\n\nok`);
  assert.match(text, /ERROR: module 15 failed to compile/);
  assert.doesNotMatch(text, /\x1b/);
  assert.match(text, /Downloading 100%/);
  assert.doesNotMatch(text, /Downloading 10%/);
  assert.doesNotMatch(text, /\n\n\n/);
});

test('prune leaves small, structured and unsaved output alone', async () => {
  const dir = tmp();
  const cfg = cfgFor(dir, { jev: 'off' });
  assert.equal((await pruneOutput(cfg, { command: 'ls', output: 'a\nb\n' })).stage, 'small');
  const json = JSON.stringify(Array.from({ length: 800 }, (_, i) => ({ id: i })));
  assert.equal((await pruneOutput(cfg, { command: 'curl api', output: json })).stage, 'document');
  assert.equal((await pruneOutput(cfg, { command: 'cat big.log', output: labeledLog() })).stage, 'document');
  const failed = await pruneOutput(cfg, { command: 'npm run build', output: labeledLog(), archivePath: '/x', saveOriginal: () => false });
  assert.equal(failed.stage, 'archive_failed');
  assert.equal(failed.text, null);
});

test('prune folds a noisy log, saves the original first and cites it', async () => {
  const dir = tmp();
  const archive = join(dir, 'out.txt');
  const result = await pruneOutput(cfgFor(dir, { jev: 'off' }), {
    command: 'npm run build',
    output: neutralLog(),
    archivePath: archive,
    saveOriginal: (text) => { writeFileSync(archive, text); return true; },
  });
  assert.equal(result.stage, 'fold');
  assert.ok(result.text.includes(archive));
  assert.equal(readFileSync(archive, 'utf8'), neutralLog());
});

test('under a preview budget the smaller of fold and Jev wins, and neither may exceed it', async () => {
  const dir = tmp();
  const result = await pruneOutput(cfgFor(dir), { command: 'npm run build', output: labeledLog(), budget: 2_300, archivePath: '/saved/by/host.txt' });
  assert.ok(['fold', 'jev'].includes(result.stage));
  assert.ok(result.visibleChars <= 2_300);
  assert.match(result.text, /sha256:7e4c9a/);
  const tight = await pruneOutput(cfgFor(dir), { command: 'npm run build', output: labeledLog(), budget: 50, archivePath: '/saved/by/host.txt' });
  assert.equal(tight.text, null);
});

test('prune never folds a search or a listing: similar-looking matches are what was asked for', async () => {
  const matches = Array.from({ length: 300 }, (_, i) => `src/module${i}.js:${i + 10}:  // TODO: remove the legacy branch in handler ${i}`).join('\n');
  const listing = Array.from({ length: 300 }, (_, i) => `-rw-r--r--  1 jhj jhj  ${1000 + i} Sep 29 10:00 report-${i}.md`).join('\n');
  const cfg = cfgFor(tmp(), { jev: 'off' });
  for (const [command, output] of [['grep -rn TODO src', matches], ['ls -la reports', listing], ['find . -name "*.md" -exec ls -la {} +', listing]]) {
    const result = await pruneOutput(cfg, { command, output, archivePath: '/x' });
    assert.equal(result.text, null, command);
  }
});

test('prune does not ask Jev when the rules already fit the budget', async () => {
  const dir = tmp();
  const result = await pruneOutput(cfgFor(dir), { command: 'npm run build', output: neutralLog(), budget: 2_300, archivePath: '/saved/by/host.txt' });
  assert.equal(result.stage, 'fold');
  assert.equal(result.jevRequests, undefined);
});

test("prune asks Jev only when enabled and only where the rules found nothing to fold", async () => {
  const words = ['resolve', 'graph', 'emit', 'asset', 'tree', 'shake', 'split', 'chunk', 'minify', 'map', 'source', 'plugin', 'loader', 'cache', 'watch'];
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  // Every line built differently, so no run of similar lines exists to fold.
  const lines = Array.from({ length: 1500 }, () => Array.from({ length: 3 + (next() % 9) }, () => words[next() % words.length]).join(next() % 2 ? ' ' : ' / '));
  lines.splice(700, 0, 'BUNDLE Q7 = sha256:7e4c9a');
  const output = lines.join('\n');
  const dir = tmp();
  const off = await pruneOutput(cfgFor(dir), { command: 'node build.mjs', output, archivePath: '/x' });
  assert.equal(off.jevRequests, undefined);
  const on = await pruneOutput(cfgFor(dir, { pruneJev: 'on' }), { command: 'node build.mjs', output, archivePath: '/x' });
  assert.ok(on.jevRequests > 0);
  assert.equal(on.stage, 'jev');
  assert.match(on.text, /sha256:7e4c9a/);
});

test('retain picks the chunks with exact values and renders them verbatim', async () => {
  const results = [
    { tool: 'Bash', command: 'Bash find . -name tmp', text: Array.from({ length: 40 }, (_, i) => `./tmp/cache-${i}`).join('\n') },
    { tool: 'Bash', command: 'Bash npm run build', text: 'BUILD START\nBUNDLE Q7 = sha256:7e4c9a\nROLLBACK TARGET = stable-snapshot\nBuild completed' },
  ];
  const selection = await selectFacts(cfgFor(tmp()), { results, messages: [], goal: 'hand off the build' });
  assert.equal(selection.stage, 'selected');
  const text = renderFacts(selection.facts);
  assert.match(text, /\$ Bash npm run build\n[\s\S]*sha256:7e4c9a/);
  assert.doesNotMatch(text, /cache-1\b/);
  assert.equal((await selectFacts(cfgFor(tmp(), { jev: 'off' }), { results, messages: [], goal: '' })).stage, 'no_jev');
});

test('hybrid retain keeps rule facts and lets Jev add semantic chunks within the same budget', async () => {
  const results = [
    { tool: 'Bash', command: 'npm run build', text: neutralLog(120, 50, 80) },
    { tool: 'Bash', command: 'node policy.mjs', text: 'release policy decision: migrations must preserve the legacy wire format' },
  ];
  const cfg = cfgFor(tmp(), { retainMaxChars: 2_000 });
  const selection = await hybridFacts(cfg, { results, messages: [], goal: 'prepare the release migration' });
  const text = renderFacts(selection.facts);
  assert.equal(selection.stage, 'selected');
  assert.ok(selection.ruleFacts > 0);
  assert.ok(selection.semanticFacts > 0);
  assert.ok(selection.jevRequests > 0);
  assert.ok(selection.chars <= cfg.retainMaxChars);
  assert.match(text, /sha256:7e4c9a/);
  assert.match(text, /migrations must preserve the legacy wire format/);
});

test('hybrid retain falls back to rule facts when Jev is unavailable', async () => {
  const results = [{ tool: 'Bash', command: 'npm run build', text: neutralLog(120, 50, 80) }];
  const selection = await hybridFacts(cfgFor(tmp(), { jev: 'off' }), { results, messages: [], goal: 'hand off the build' });
  assert.equal(selection.stage, 'selected');
  assert.equal(selection.jevStage, 'no_jev');
  assert.equal(selection.semanticFacts, 0);
  assert.match(renderFacts(selection.facts), /sha256:7e4c9a/);
});
