// Live comparison of the compaction engines on one long Claude Code session,
// the 2026-09-26 setup (docs/2026-09-26-compaction-cache.md) rebuilt here.
//   node scripts/e2e-compact.mjs base              7 turns, 14 × ~22k-char tool outputs, no plugin
//   node scripts/e2e-compact.mjs branches [arms]   fork the base per arm: /compact and the hand-off
//                                                  question in one process, then (verbatim) the
//                                                  same question again after --resume
// Arms: summary (built-in + retain), verbatim (this plugin's function hook), upstream
// (fast-jev-compaction as published). Needs TYPESAFE_API_KEY in the shell.
// Prints sizes, timings, decisions and which exact values each answer holds.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BLOCK, GUARD, settleSource } from './fixtures/settle.mjs';

const root = resolve(import.meta.dirname, '..');
const dir = process.env.E2E_COMPACT_DIR ?? join(tmpdir(), 'jev-compact-e2e');
const work = join(dir, 'work');
const bin = join(dir, 'bin');
const truthPath = join(dir, 'truth.json');
const statePath = join(dir, 'state.json');
const model = process.env.E2E_MODEL ?? 'sonnet';
// fast-jev-compaction as published: the pinned clone `npm run setup` makes is the plugin itself.
const upstream = process.env.FAST_JEV_PLUGIN ?? resolve(root, 'vendor/fast-jev-compaction');
mkdirSync(work, { recursive: true });
mkdirSync(bin, { recursive: true });
// Outside the working directory: the agent can run the tool but not read its source.
writeFileSync(join(bin, 'ledger-tool'), `#!/bin/sh\nexec node "${join(root, 'scripts/fixtures/ledger-tool.mjs')}" "$@"\n`);
chmodSync(join(bin, 'ledger-tool'), 0o755);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ORCA')));
Object.assign(env, { PATH: `${bin}:${env.PATH}`, LEDGER_TRUTH: truthPath });
const COMMON = ['--model', model, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash(ledger-tool:*)'];

const RUN = '출력은 파이프·리다이렉트·tail 없이 명령 그대로 받아서 읽고, 핵심만 두세 줄로 보고해.';
const TURNS = [
  `ledger-api 릴리스 점검을 시작하자. \`ledger-tool deps\`와 \`ledger-tool lint\`를 실행해. ${RUN}`,
  `\`ledger-tool test\`와 \`ledger-tool tree\`를 실행해. ${RUN}`,
  `\`ledger-tool build\`와 \`ledger-tool env\`를 실행해. ${RUN}`,
  `\`ledger-tool bench\`와 \`ledger-tool audit\`를 실행해. ${RUN}`,
  `\`ledger-tool release\`로 카나리를 배포해. 딱 한 번만 실행해(다시 실행하면 새 릴리스가 생긴다). 이어서 \`ledger-tool logs\`도 실행해. ${RUN}`,
  `\`ledger-tool metrics\`와 \`ledger-tool migrations\`를 실행해. ${RUN}`,
  `\`ledger-tool flags\`와 \`ledger-tool changelog\`를 실행해. ${RUN}`,
];
const WARMUP = 'Reply with just: ok';
const HANDOFF = '도구는 쓰지 말고 지금까지의 대화만으로 인수인계 메모를 써줘. 정확한 값으로: (1) 실패한 테스트 이름과 재현 seed, (2) BUNDLE Q7 해시, (3) 카나리 RELEASE ID, (4) ROLLBACK TOKEN. 대화에 없어 모르는 값은 "모름"이라고 적어.';

function parse(stdout) {
  return stdout.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function measure(events) {
  const perMessage = new Map();
  const texts = [];
  let reads = 0;
  for (const e of events.filter((e) => e.type === 'assistant')) {
    if (e.message?.usage) perMessage.set(e.message.id, e.message.usage);
    for (const b of e.message?.content ?? []) {
      if (b.type === 'text') texts.push(b.text);
      if (b.type === 'tool_use' && (b.name === 'Read' || /settle\.ts/.test(JSON.stringify(b.input)))) reads += 1;
    }
  }
  const first = [...perMessage.values()][0];
  const result = events.find((e) => e.type === 'result');
  return {
    session: result?.session_id,
    cost: result?.total_cost_usd ?? 0,
    firstRequest: first && { context: first.input_tokens + first.cache_read_input_tokens + first.cache_creation_input_tokens, write: first.cache_creation_input_tokens, read: first.cache_read_input_tokens },
    boundary: events.find((e) => e.subtype === 'compact_boundary')?.compact_metadata ?? null,
    result: result?.result,
    isError: result?.is_error ?? null,
    text: texts.join('\n'),
    reads,
  };
}

function values(text, path = truthPath) {
  const truth = JSON.parse(readFileSync(path, 'utf8'));
  const has = { test: /settles idempotent retries once/, seed: /48213/, bundle: /7e4c9a1fd20b/, release: new RegExp(truth.releaseId), rollback: new RegExp(truth.rollbackToken) };
  return Object.entries(has).filter(([, re]) => re.test(text)).map(([k]) => k);
}

/** Runs prompts one after another in ONE process (stream-json input), as an interactive session would. */
function inProcess(args, prompts, extraEnv, common = COMMON) {
  return new Promise((done) => {
    const child = spawn('claude', ['-p', '--input-format', 'stream-json', ...common, ...args], { cwd: work, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    const segments = [];
    let current = [];
    let sent = 0;
    let started = 0;
    const times = [];
    const send = () => {
      started = Date.now();
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompts[sent] } })}\n`);
      sent += 1;
    };
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        current.push(e);
        if (e.type === 'result') {
          times.push(Date.now() - started);
          segments.push(current);
          current = [];
          if (sent < prompts.length) send();
          else child.stdin.end();
        }
      }
    });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', (code) => done({ code, err: err.slice(-400), parts: segments.map((s, i) => ({ ...measure(s), wallMs: times[i] })) }));
    send();
  });
}

function decisions(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((d) => ['session-compact', 'pre-compact', 'session-start'].includes(d.hook))
    .map(({ hook, decision, reduction, charsBefore, charsAfter, kept, resultsDropped, callsDropped, rescuedResults, rescuedChars, stateTokens, stateStage, jevRequests, facts, chars, picker, carry, carryAsked, carried, carryChars, carryScores, elapsedMs, error }) =>
      ({ hook, decision, reduction, charsBefore, charsAfter, kept, resultsDropped, callsDropped, rescuedResults, rescuedChars, stateTokens, stateStage, jevRequests, facts, chars, picker, carry, carryAsked, carried, carryChars, carryScores, elapsedMs, error }));
}

const topicsTruth = join(dir, 'truth-topics.json');
const FILE_COMMON = ['--model', model, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash(ledger-tool:*)', 'Read'];
// E2E_PATCH=block asks for the guard with two lines on each side: neighbours
// shaped alike, so only a result kept whole (or a re-read) can quote them.
const PATCH_BLOCK = '이제 그 가드를 고치자. 파일을 다시 읽지 말고, 방금 읽은 내용 그대로 바탕으로 가드 행과 그 앞뒤 두 줄씩, 모두 다섯 줄을 원문 그대로 인용한 다음, 가드를 고친 다섯 줄을 써줘.';
const PATCH = '이제 그 가드를 고치자. 파일을 다시 읽지 말고, 방금 읽은 내용 그대로 바탕으로 해당 행의 현재 코드 한 줄을 정확히 인용한 다음, 고친 코드 한 줄을 써줘.';
function writeSettle() {
  mkdirSync(join(work, 'src/ledger'), { recursive: true });
  writeFileSync(join(work, 'src/ledger/settle.ts'), settleSource());
}
/** Plugin arguments and environment per arm; `topics` is verbatim with exchange dropping. */
function armPlan(arm, prefix) {
  const kind = arm.split('#')[0];
  const tag = `${prefix}-${arm.replace('#', '-')}`;
  const log = join(dir, `${tag}.jsonl`);
  const env = { JEV_CONTEXT_RESUME: 'off', JEV_CONTEXT_IDLE: 'off', JEV_CONTEXT_JEV: 'live', JEV_CONTEXT_READ_GATE: 'off', JEV_CONTEXT_LOG: log, JEV_CONTEXT_STATE_DIR: join(dir, `${tag}-state`) };
  if (kind === 'summary') env.JEV_CONTEXT_COMPACT = 'summary';
  else Object.assign(env, { JEV_CONTEXT_COMPACT: 'verbatim', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', ...(kind === 'topics' ? { JEV_CONTEXT_COMPACT_TOPICS: 'on' } : {}) });
  return { args: ['--plugin-dir', root], env, log };
}

const stage = process.argv[2];
if (stage === 'base') {
  let sid;
  state.base = [];
  for (const [i, prompt] of TURNS.entries()) {
    const args = ['-p', prompt, ...COMMON, ...(sid ? ['--resume', sid] : [])];
    const run = spawnSync('claude', args, { cwd: work, env, input: '', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const m = measure(parse(run.stdout));
    sid ??= m.session;
    state.base.push({ turn: i + 1, cost: m.cost, firstRequest: m.firstRequest });
    console.log(`base ${i + 1}: context ${m.firstRequest?.context} cost $${m.cost.toFixed(3)}`);
    save();
  }
  state.baseSession = sid;
  save();
} else if (stage === 'branches') {
  if (!state.baseSession) throw new Error('run base first');
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY missing');
  const arms = (process.argv[3] ?? 'verbatim,upstream,summary').split(',');
  // Only compaction is under test: the resume trigger and the idle guard stay out.
  // Live Jev is opt-in even with a key in the shell (JEV_CONTEXT_JEV).
  const quiet = { JEV_CONTEXT_RESUME: 'off', JEV_CONTEXT_IDLE: 'off', JEV_CONTEXT_JEV: 'live' };
  const plans = {
    summary: { args: ['--plugin-dir', root], env: { ...quiet, JEV_CONTEXT_COMPACT: 'summary' } },
    verbatim: { args: ['--plugin-dir', root], env: { ...quiet, JEV_CONTEXT_COMPACT: 'verbatim', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }, resume: true },
    upstream: { args: ['--plugin-dir', upstream], env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }, resume: true },
  };
  state.branches ??= {};
  // `summary#2` repeats an arm; E2E_SKIP_RESUME=1 leaves out the --resume check.
  for (const arm of arms) {
    const plan = plans[arm.split('#')[0]];
    const log = join(dir, `decisions-${arm.replace('#', '-')}.jsonl`);
    const armEnv = { ...plan.env, JEV_CONTEXT_LOG: log, JEV_CONTEXT_STATE_DIR: join(dir, `state-${arm.replace('#', '-')}`) };
    const debug = join(dir, `${arm.replace('#', '-')}.debug.log`);
    // A fork's transcript file appears with its first entry; without the 'ok'
    // turn the retain PreCompact hook would find nothing to read (measured).
    const run = await inProcess([...plan.args, '--debug-file', debug, '--resume', state.baseSession, '--fork-session'], [WARMUP, '/compact', HANDOFF], armEnv);
    const [, compact, handoff] = run.parts;
    const row = {
      arm,
      exit: run.code,
      compact: { wallMs: compact?.wallMs, result: compact?.result, boundary: compact?.boundary },
      handoff: handoff && { firstRequest: handoff.firstRequest, cost: handoff.cost, values: values(handoff.text), wallMs: handoff.wallMs, isError: handoff.isError },
      decisions: decisions(log),
      session: handoff?.session ?? compact?.session,
    };
    if (plan.resume && row.session && !process.env.E2E_SKIP_RESUME) {
      // E2E_RESUME_GUARD=1: the resume runs with the timing module on, which
      // should notice the undone compaction and run /compact first.
      const resumeEnv = process.env.E2E_RESUME_GUARD ? { JEV_CONTEXT_RESUME: 'compact' } : {};
      const again = spawnSync('claude', ['-p', HANDOFF, ...COMMON, ...plan.args, '--resume', row.session], { cwd: work, env: { ...env, ...armEnv, ...resumeEnv }, input: '', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const m = measure(parse(again.stdout));
      row.afterResume = { guard: Boolean(process.env.E2E_RESUME_GUARD), firstRequest: m.firstRequest, boundary: m.boundary, cost: m.cost, values: values(m.text), isError: m.isError, decisions: decisions(log).slice(row.decisions.length) };
    }
    if (run.code !== 0) row.stderr = run.err;
    state.branches[arm] = row;
    save();
    console.log(JSON.stringify(row));
  }
} else if (stage === 'far-base') {
  // Experiment 1, base: read the file, then three more release-check turns so
  // the read falls outside what the built-in summary keeps verbatim, then say
  // the next step fixes the guard.
  if (!state.baseSession) throw new Error('run base first');
  writeSettle();
  const prompts = [
    '실패한 settle 테스트의 원인을 보자. Read 도구로 `src/ledger/settle.ts` 전체를 한 번 읽고, 재시도를 두 번 과금하게 만드는 가드가 몇 행인지만 한 줄로 알려줘. 릴리스 점검을 마저 끝낸 다음에 그 가드를 고칠 거야.',
    `\`ledger-tool metrics\`와 \`ledger-tool logs\`를 다시 실행해서 최신 상태를 확인해. ${RUN}`,
    `\`ledger-tool bench\`와 \`ledger-tool audit\`를 다시 실행해. ${RUN}`,
    `\`ledger-tool flags\`와 \`ledger-tool env\`를 다시 실행해. ${RUN}`,
    "릴리스 점검은 이걸로 끝이야. 다음엔 아까 말한 settle.ts 가드를 고칠 거야. 준비됐으면 '준비됨'이라고만 답해.",
  ];
  const run = await inProcess(['--resume', state.baseSession, '--fork-session'], prompts, {}, FILE_COMMON);
  state.farBase = run.parts.at(-1)?.session;
  state.farBaseParts = run.parts.map((p) => ({ context: p.firstRequest?.context, cost: p.cost, reads: p.reads }));
  save();
  console.log(JSON.stringify({ farBase: state.farBase, parts: state.farBaseParts, exit: run.code }));
} else if (stage === 'far') {
  if (!state.farBase) throw new Error('run far-base first');
  const arms = (process.argv[3] ?? 'verbatim,summary').split(',');
  state.far ??= {};
  for (const arm of arms) {
    const { args, env: armEnv, log } = armPlan(arm, 'far');
    const block = process.env.E2E_PATCH === 'block';
    const run = await inProcess([...args, '--resume', state.farBase, '--fork-session'], [WARMUP, '/compact', block ? PATCH_BLOCK : PATCH], armEnv, FILE_COMMON);
    const [, compact, patch] = run.parts;
    const row = {
      arm, exit: run.code, prompt: block ? 'block' : 'line',
      compact: compact?.boundary && { pre: compact.boundary.pre_tokens, post: compact.boundary.post_tokens, ms: compact.boundary.duration_ms },
      patch: patch && { context: patch.firstRequest?.context, quotedExactly: patch.text.includes(GUARD), blockLines: BLOCK.filter((l) => patch.text.includes(l)).length, rereads: patch.reads },
      decisions: decisions(log).filter((d) => d.hook === 'session-compact'),
    };
    state.far[`${arm}${block ? '+block' : ''}`] = row;
    save();
    console.log(JSON.stringify(row));
  }
} else if (stage === 'topics-base') {
  // Experiment 2, base: a new session with three topics. A: the release check
  // (values in tool output), B: a long document discussion the user closes,
  // C: the current code fix.
  writeSettle();
  const prompts = [
    `ledger-api 릴리스 점검을 시작하자. \`ledger-tool test\`와 \`ledger-tool build\`를 실행해. ${RUN}`,
    `\`ledger-tool release\`로 카나리를 배포해. 딱 한 번만 실행해(다시 실행하면 새 릴리스가 생긴다). 이어서 \`ledger-tool logs\`도 실행해. ${RUN}`,
    '잠깐 다른 얘기. 이 저장소에 CONTRIBUTING.md를 새로 쓴다면 어떤 목차가 좋을지, 목차 항목마다 두세 문단씩 자세히 설명해줘. 도구는 쓰지 마.',
    '좋아. 그 목차의 각 항목에 들어갈 예시 문단도 하나씩 써줘. 도구는 쓰지 마.',
    '그 문서 얘기는 여기까지. 다시 코드로 돌아가자. Read 도구로 `src/ledger/settle.ts` 전체를 읽고, 재시도를 두 번 과금하게 만드는 가드가 몇 행인지만 한 줄로 알려줘. 다음 단계에서 그 가드를 고칠 거야.',
  ];
  const run = await inProcess([], prompts, { LEDGER_TRUTH: topicsTruth }, FILE_COMMON);
  state.topicsBase = run.parts.at(-1)?.session;
  // The first heading of the outline, to check whether topic B survived.
  const outline = run.parts[2]?.text ?? '';
  const outlineLines = outline.split('\n').map((l) => l.trim());
  state.topicsFirstHeading = outlineLines.find((l) => /^\d+[.)]\s+\S/.test(l)) ?? outlineLines.find((l) => /^#{2,4}\s+\d/.test(l)) ?? null;
  state.topicsBaseParts = run.parts.map((p) => ({ context: p.firstRequest?.context, cost: p.cost, textChars: p.text.length }));
  save();
  console.log(JSON.stringify({ topicsBase: state.topicsBase, firstHeading: state.topicsFirstHeading, parts: state.topicsBaseParts, exit: run.code }));
} else if (stage === 'topics') {
  if (!state.topicsBase) throw new Error('run topics-base first');
  const ASK = "도구는 쓰지 말고 답해. (1) settle.ts 가드 행의 현재 코드 한 줄을 정확히 인용하고, 고친 한 줄을 써줘. (2) 카나리 RELEASE ID는? (3) 아까 CONTRIBUTING 목차의 첫 항목 제목은? 대화에 없어 모르는 것은 '모름'이라고 적어.";
  const arms = (process.argv[3] ?? 'summary,verbatim,topics').split(',');
  const heading = (state.topicsFirstHeading ?? '').replace(/^(#{1,4}\s+|\d+[.)]\s+|\*\*)/, '').replace(/\*\*/g, '').replace(/^\d+[.)]\s*/, '').split(/[:(—-]/)[0].trim();
  state.topics ??= {};
  for (const arm of arms) {
    const { args, env: armEnv, log } = armPlan(arm, 'topics');
    const run = await inProcess([...args, '--resume', state.topicsBase, '--fork-session'], [WARMUP, '/compact', ASK], armEnv, FILE_COMMON);
    const [, compact, answer] = run.parts;
    const row = {
      arm, exit: run.code,
      compact: compact?.boundary && { pre: compact.boundary.pre_tokens, post: compact.boundary.post_tokens, ms: compact.boundary.duration_ms },
      answer: answer && {
        context: answer.firstRequest?.context,
        guardQuoted: answer.text.includes(GUARD),
        release: values(answer.text, topicsTruth).includes('release'),
        heading: heading ? answer.text.includes(heading) : null,
        headingExpected: heading,
        rereads: answer.reads,
      },
      decisions: decisions(log).filter((d) => d.hook === 'session-compact'),
    };
    state.topics[arm] = row;
    save();
    console.log(JSON.stringify(row));
  }
} else if (stage === 'shell-base') {
  // The file is read through the shell, which Claude Code does not re-attach
  // after a compaction (it re-attaches files read with its Read tool).
  writeSettle();
  const prompts = [
    `ledger-api 릴리스 점검을 시작하자. \`ledger-tool test\`와 \`ledger-tool build\`를 실행해. ${RUN}`,
    'Read 도구는 쓰지 말고 Bash로 `cat src/ledger/settle.ts`를 한 번 실행해서 읽고, 재시도를 두 번 과금하게 만드는 가드가 몇 행인지만 한 줄로 알려줘. 릴리스 점검을 마저 끝낸 다음에 그 가드를 고칠 거야.',
    `\`ledger-tool logs\`와 \`ledger-tool metrics\`를 실행해. ${RUN}`,
    "릴리스 점검은 이걸로 끝이야. 다음엔 아까 말한 settle.ts 가드를 고칠 거야. 준비됐으면 '준비됨'이라고만 답해.",
  ];
  const common = ['--model', model, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash(ledger-tool:*)', 'Bash(cat:*)'];
  const run = await inProcess([], prompts, {}, common);
  state.shellBase = run.parts.at(-1)?.session;
  state.shellBaseParts = run.parts.map((p) => ({ context: p.firstRequest?.context, reads: p.reads }));
  save();
  console.log(JSON.stringify({ shellBase: state.shellBase, parts: state.shellBaseParts, exit: run.code }));
} else if (stage === 'shell') {
  if (!state.shellBase) throw new Error('run shell-base first');
  const arms = (process.argv[3] ?? 'rules,on').split(',');
  state.shell ??= {};
  for (const arm of arms) {
    const kind = arm.split('#')[0];
    const { args, env: armEnv, log } = armPlan('summary', `shell-${arm.replace('#', '-')}`);
    armEnv.JEV_CONTEXT_RETAIN = kind;
    const common = ['--model', model, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash(ledger-tool:*)', 'Bash(cat:*)', 'Read'];
    const run = await inProcess([...args, '--resume', state.shellBase, '--fork-session'], [WARMUP, '/compact', PATCH_BLOCK], armEnv, common);
    const [, compact, patch] = run.parts;
    const row = {
      arm, exit: run.code,
      compact: compact?.boundary && { pre: compact.boundary.pre_tokens, post: compact.boundary.post_tokens, ms: compact.boundary.duration_ms },
      patch: patch && { context: patch.firstRequest?.context, guard: patch.text.includes(GUARD), blockLines: BLOCK.filter((l) => patch.text.includes(l)).length, rereads: patch.reads },
      retain: decisions(log).filter((d) => d.hook === 'pre-compact' || (d.hook === 'session-start' && d.decision === 'injected')),
    };
    state.shell[arm] = row;
    save();
    console.log(JSON.stringify(row));
  }
} else if (stage === 'file') {
  // Does compaction keep what the very next step works on? The fork reads a
  // real file and is told the next step patches it; after /compact it must
  // write the patch without reading the file again.
  if (!state.baseSession) throw new Error('run base first');
  writeSettle();
  const READ = '실패한 settle 테스트의 원인을 보자. Read 도구로 `src/ledger/settle.ts` 전체를 한 번 읽고, 재시도를 두 번 과금하게 만드는 가드가 몇 행인지만 한 줄로 알려줘. 다음 단계에서 바로 그 가드를 고칠 거야.';
  const arms = (process.argv[3] ?? 'verbatim,summary').split(',');
  const plans = {
    summary: { args: ['--plugin-dir', root], env: { JEV_CONTEXT_COMPACT: 'summary' } },
    verbatim: { args: ['--plugin-dir', root], env: { JEV_CONTEXT_COMPACT: 'verbatim', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } },
  };
  state.file ??= {};
  for (const arm of arms) {
    const plan = plans[arm.split('#')[0]];
    const log = join(dir, `file-${arm.replace('#', '-')}.jsonl`);
    const armEnv = { ...plan.env, JEV_CONTEXT_RESUME: 'off', JEV_CONTEXT_IDLE: 'off', JEV_CONTEXT_JEV: 'live', JEV_CONTEXT_READ_GATE: 'off', JEV_CONTEXT_LOG: log, JEV_CONTEXT_STATE_DIR: join(dir, `file-state-${arm.replace('#', '-')}`) };
    const run = await inProcess([...plan.args, '--resume', state.baseSession, '--fork-session'], [READ, '/compact', PATCH], armEnv, FILE_COMMON);
    const [read, compact, patch] = run.parts;
    const row = {
      arm,
      exit: run.code,
      compact: compact?.boundary && { pre: compact.boundary.pre_tokens, post: compact.boundary.post_tokens, ms: compact.boundary.duration_ms },
      read: read && { reads: read.reads },
      patch: patch && { context: patch.firstRequest?.context, quotedExactly: patch.text.includes(GUARD), rereads: patch.reads },
      decisions: decisions(log).filter((d) => d.hook === 'session-compact'),
    };
    state.file[arm] = row;
    save();
    console.log(JSON.stringify(row));
  }
} else {
  console.error('usage: node scripts/e2e-compact.mjs base|branches|file [arms]');
  process.exit(2);
}
