# Codex에서 jev-context 테스트하기

Claude Code에서 검증한 모듈이 Codex에서도 동작하는지 확인하는 절차다. 서브에이전트 보고를 줄이는 방법이 Codex에서 가능한지도 조사한다. Codex 세션이 이 문서를 위에서부터 그대로 따라 실행한다고 가정하고 썼다.

모든 결과에는 **라이브 Jev인지 simulated인지, `codex exec`인지 대화형인지**를 함께 적는다(`2026-09/AGENTS.md`).

## 0. 이미 알려진 사실

Claude Code 세션에서 `codex exec`로 직접 확인한 것이다(Codex CLI 0.158.0, 2026-09-29). 다른 버전이나 호스트에서 열린 Codex 세션이면 달라질 수 있으니 먼저 다시 확인한다.

**hook 동작**
- 프로젝트 폴더의 `.codex/hooks.json`이 적용된다. 신뢰 승인은 대화형이면 `/hooks`, 비대화형이면 `--dangerously-bypass-hook-trust`로 한다.
- **PreToolUse**
  - `updatedInput`으로 실행되는 셸 명령을 바꿀 수 있다. 모델은 원래 명령을 실행했다고 기억하고, 바뀐 출력만 본다.
  - `updatedInput`을 쓰려면 `permissionDecision: "allow"`가 반드시 함께 있어야 한다. 즉 **바꾼 명령은 승인 절차를 건너뛴다.**
- **PostToolUse**는 셸 출력을 바꿀 수 없다. `updatedMCPToolOutput`은 MCP 도구에만 적용된다.
- **PreCompact**(`trigger`, `transcript_path`)와 **SessionStart**(`source: "compact"`)의 `additionalContext`가 동작한다. `-c model_auto_compact_token_limit=4000`으로 자동 압축을 일으킬 수 있다.

**서브에이전트 (`multi_agent` 기능이 stable, 기본 켜짐)**
- 띄우는 도구는 `collaborationspawn_agent`다. 입력은 `task_name`, `fork_turns: "all"`, `message`인데, **`message`는 암호화된 문자열**이라 hook이 읽거나 고칠 수 없다.
- 기다리는 도구는 `collaborationwait_agent`이고, 결과는 `{"message":"Wait completed."}`뿐이다.
- 서브에이전트의 결과는 부모 rollout에 **`agent_message` 항목**으로 들어간다(`author: "/root/<task_name>"`, 내용은 "Message Type: FINAL_ANSWER…").
- `SubagentStart`는 `agent_id`와 `agent_type: "default"`를 받는다. `SubagentStop`은 `last_assistant_message`(결과 전체), `agent_transcript_path`, `stop_hook_active`를 받는다.

**실행 환경**
- Claude Code 샌드박스 안에서 `codex exec -s workspace-write`를 실행하면, bubblewrap이 `RTM_NEWADDR: Operation not permitted`로 실패했다. 그래서 그 환경에서는 `-s danger-full-access`로 돌렸다. 호스트에서 직접 연 Codex 세션이라면 이 문제가 없을 수 있다.

**플러그인에 이미 구현된 Codex 동작** (`codex/hooks.json`)

| hook | 모듈 | Codex 라이브 확인 |
| --- | --- | --- |
| `PreToolUse(Bash)` | 읽기 게이트(100줄 이상, 목적이 보일 때 Jev 판단 후 거부) + prune 감싸기(옵트인) | 감싸기만 확인(`npm run build` 133,103자 → 1,024자) |
| `PreCompact` + `SessionStart(compact)` | retain | 확인(자동 압축 후 값 보존) |
| `SubagentStop` | 보고 예산 가드(3,000자 초과 시 원문을 저장하고 한 번 되돌림) | 확인(Codex 세션, 6,439자 → 440자) |

**2026-09-29 Codex 세션 실행 결과**는 [codex-test-results-2026-09-29.md](codex-test-results-2026-09-29.md)에 있다(simulated Jev, `gpt-5.6-sol`). S1–S5가 모두 동작했다. 그 뒤 바뀐 점: retain 기본 선택기가 규칙이 됐고(`picker: rules`), Claude Code 전용 verbatim 압축이 추가됐다. Codex에는 압축 내용을 바꿀 hook이 없어 verbatim은 해당이 없다. 라이브 Jev로 다시 볼 것은 S3(읽기 게이트 판정)이다.

## 1. 준비

```sh
cd 2026-09/jev-context
npm run setup          # vendor/jev-pruner, vendor/fast-jev-compaction 빌드
npm test               # 오프라인 테스트 먼저. 40개 통과를 확인한다
export TYPESAFE_API_KEY=... JEV_CONTEXT_JEV=live   # 셸에만. 파일·로그·화면에 남기지 않는다
```

사용자의 `~/.codex`는 건드리지 않는다. 테스트용 폴더를 따로 만들고 거기에 프로젝트 hooks를 설치한다.

```sh
ROOT="$PWD"
W=$(mktemp -d)/codex-jev && mkdir -p "$W"
node "$ROOT/scripts/codex-project-hooks.mjs" "$W" --dump   # 플러그인 hooks + 모든 이벤트 관찰 hook
export JEV_CONTEXT_LOG="$W/decisions.jsonl" JEV_CONTEXT_STATE_DIR="$W/.state" JEV_CONTEXT_DUMP_DIR="$W/dump"
cp -r "$ROOT/src" "$W/src"          # 읽기·위임 과제에 쓸 실제 코드
cp "$ROOT/README.md" "$W/README.md"
```

- hook은 Codex를 **시작할 때의 환경 변수**를 이어받는다. 위 `export`는 반드시 Codex를 열기 전에 한다.
- 대화형으로 하려면 `cd "$W" && codex`로 연 뒤 `/hooks`에서 신뢰를 승인한다.
- 비대화형으로 하려면 `codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --json '<프롬프트>'`를 쓴다.

**결과를 볼 곳**
- `$W/decisions.jsonl`: 플러그인의 판단. `hook`, `decision`, 크기, `jevRequests`, `elapsedMs`가 들어 있다.
- `$W/dump/`: 관찰 hook이 남긴 이벤트별 입력. 긴 문자열은 400자에서 자른다.
- `node "$ROOT/scripts/codex-rollout-stats.mjs"`: 가장 최근 rollout의 도구 출력량, 서브에이전트 결과 크기, 압축 횟수, 마지막 요청 토큰. 내용은 출력하지 않는다.

## 2. 시나리오

### S1. prune: 빌드 로그 감싸기 (자동화 스크립트 있음)

```sh
E2E_CODEX_SANDBOX=danger-full-access npm run e2e:codex   # 호스트 세션이면 workspace-write로도 시도
```

- **보는 것:** `pre-tool-use`가 `wrapped`인지, `codex-run`이 `fold`인지. 모델이 본 출력 크기, 종료 코드, 두 값(`sha256:7e4c9a`, `stable-snapshot`)이 남았는지.
- **주의:** `JEV_CONTEXT_CODEX_WRAP=on`은 감싼 명령의 승인을 건너뛴다. 빌드·테스트·설치·린트 패턴에만 적용된다.
- **대화형으로 할 때:** `export JEV_CONTEXT_CODEX_WRAP=on` 후 Codex를 열고 "Run `npm run build` exactly once and report the bundle Q7 digest and the rollback target." 이때 `package.json`과 `noisy.mjs`는 `scripts/e2e-codex.mjs`가 만드는 것을 복사해 쓴다.

### S2. retain: 자동 압축 후 사실 보존 (자동화 스크립트에 포함)

`npm run e2e:codex`의 두 번째 장면이다.

- **보는 것:** `pre-compact`의 `decision: selected`, `picker: rules`(기본값. 규칙 뒤 남은 예산을 Jev로 보완하려면 `JEV_CONTEXT_RETAIN=hybrid`), `trigger: auto`, `session-start`의 `injected`, rollout의 압축 횟수, 압축 후 답에 두 값이 있는지.
- **대화형으로 할 때:** S1 세션을 `-c model_auto_compact_token_limit=4000`으로 다시 열고, "Without running any command, state the bundle Q7 digest and the rollback target exactly."

### S3. 읽기 게이트: 긴 파일을 통째로 읽으려 할 때 (Codex 미확인)

프롬프트: "`src/core/readgate.mjs`에서 읽기 크기를 계산하는 함수가 `tail -n +K`를 어떻게 처리하는지 찾아서 알려줘."

- **보는 것:**
  - 모델이 `cat src/core/readgate.mjs`처럼 100줄 이상을 한 번에 읽으려 할 때 `pre-tool-use`가 `denied`(p 값 포함)인지, 목적이 보이지 않아 `no_intent`인지.
  - 거부 사유(개요 포함)가 **모델에게 전달되는지**. 모델이 개요를 보고 `sed -n`으로 좁혀 읽는지.
  - 같은 명령을 다시 요청했을 때 `repeated`로 통과하는지.
- **확인할 질문:** Codex에서 `permissionDecision: "deny"`와 `permissionDecisionReason`이 모델에게 어떤 모양으로 보이는가. `$W/dump`의 PreToolUse 입력과 모델의 다음 행동으로 판단한다.

### S4. 보고 예산 가드: 긴 서브에이전트 결과 (Codex 미확인)

프롬프트: "Spawn exactly one subagent and give it this task: 'Without running commands, write a reference table of 40 common HTTP status codes, each with a two-sentence explanation, as your final answer.' Wait for it, then tell me how many characters its result was."

- **보는 것:**
  - `subagent-stop` 로그의 `decision`(`asked_to_shorten`, `within_budget`, `internal_agent`)과 `reportChars`, 그리고 `archive` 파일이 실제로 생겼는지.
  - `SubagentStop` block 이후 서브에이전트가 **이어서 작업하는지**, 부모가 받는 `agent_message`가 **두 번째(짧아진) 답인지**. `codex-rollout-stats.mjs`의 "subagent result" 크기로 확인한다.
  - 비교를 위해 `JEV_CONTEXT_REPORT_MAX_CHARS=100000000`(가드 끔)으로 같은 프롬프트를 한 번 더 돌린다.
- **확인할 질문:** Codex에서 `SubagentStop`의 block이 Claude Code처럼 "서브에이전트가 한 턴 더 일함"으로 이어지는가. 이어진다면 추가 턴의 비용과 시간은 얼마인가.

### S5. 조사: 보고를 줄일 수 있는 지점 (관찰만)

Claude Code에서는 지시문과 전달 본문을 모두 `updatedInput`으로 바꿔 "Summary와 경로만 전달"을 구현했다. Codex에서는 둘 다 막혀 있다(지시문 암호화, 본문 교체 불가). `--dump`로 남긴 입력을 보고 다음 질문에 답한다.

1. 서브에이전트 안에서 실행된 도구 호출에도 `PreToolUse`/`PostToolUse`가 발동하는가. 발동한다면 입력에 `agent_id`가 들어 있는가. 들어 있다면 읽기 게이트가 서브에이전트를 제외할 수 있다.
2. `SubagentStart`의 출력 스키마에 있는 `additionalContext`가 서브에이전트의 맥락에 실제로 들어가는가. 짧은 표식 문자열을 반환하는 임시 hook을 걸고, 서브에이전트가 그 표식을 답에 언급하는지로 확인한다. 들어간다면 보고 형식 안내를 서브에이전트에 전달할 경로가 생긴다.
3. `fork_turns: "all"`인 서브에이전트의 첫 요청 입력 토큰은 부모 컨텍스트와 비교해 얼마인가. 서브에이전트 rollout의 `token_count`에서 읽는다. 부모 대화 전체를 이어받는 비용을 재기 위한 것이다.

이 단계에서는 hook 코드를 바꾸지 않는다. 답을 정리한 뒤 구현 여부를 정한다.

## 3. 결과 기록 양식

| 시나리오 | 실행 방식 (exec/대화형, 샌드박스) | 모델 | Jev (live/simulated) | 로그 결정 | 모델이 받은 크기 | 값/정답 | 비고 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 prune | | | | | | | |
| S2 retain | | | | | | | |
| S3 읽기 게이트 | | | | | | | |
| S4 보고 가드 (켬) | | | | | | | |
| S4 보고 가드 (끔) | | | | | | | |
| S5 조사 1–3 | | | | | | | 질문별 답 |

## 4. 주의

- 줄어든 비율을 모듈끼리 합산하거나 절감을 보장하는 식으로 말하지 않는다. 장면별로 잰 수치만 적는다.
- 라이브 Jev는 대화 일부와 도구 출력, 파일 개요를 TypeSafe로 보낸다. 이 절차는 이 저장소의 코드와 합성 픽스처만 쓴다.
- 끝나면 `$W`를 지운다. 사용자의 `~/.codex/config.toml`과 `~/.codex/hooks.json`에는 아무것도 쓰지 않는다.
