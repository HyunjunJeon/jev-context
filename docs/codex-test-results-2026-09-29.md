# Codex 테스트 결과 — 2026-09-29

`CODEX-TEST.md`의 절차에 따라 `jev-context`를 Codex에서 검증한 기록이다.

## 실행 환경

| 항목 | 값 |
| --- | --- |
| 실행일 | 2026-09-29 |
| 실행 방식 | 비대화형 `codex exec` |
| Codex CLI | 0.158.0 |
| 모델 | `gpt-5.6-sol` |
| 샌드박스 | `danger-full-access` |
| Node.js | 24.18.0 |
| Jev | **simulated** (`TYPESAFE_API_KEY` 미설정) |

이 결과는 라이브 TypeSafe/Jev 측정이 아니다. 모든 입력은 저장소 코드와 합성 픽스처만 사용했다.

## 요약

| 시나리오 | 로그 결정 | 모델이 받은 크기 | 결과 |
| --- | --- | ---: | --- |
| 오프라인 테스트 | 31개 통과 | 해당 없음 | 통과 |
| S1 prune | `wrapped` → `fold` | 1,024자 | 통과 |
| S2 retain | `selected` → `injected` | retain 1,198자 | 통과 |
| S3 읽기 게이트 | `denied`, 이후 `below_threshold` | 거부 개요 및 40줄·14줄 | 통과 |
| S3 같은 명령 재시도 | `repeated` | 전체 파일 6,948자 | 통과 |
| S4 보고 가드 켬 | `asked_to_shorten` → `already_asked` | 부모 rollout 440자 | 통과 |
| S4 보고 가드 끔 | `within_budget` | 부모 rollout 7,193자 | 통과 |
| S5 조사 | 관찰 hook | 아래 질문 1–3 참조 | 확인 완료 |

## 사전 검사

```text
npm run setup: 성공
npm test: 31 passed, 0 failed
```

`vendor/jev-pruner`를 빌드한 뒤 로컬 오프라인 테스트를 먼저 실행했다.

## S1. prune: 빌드 로그 감싸기

실행 명령:

```sh
E2E_CODEX_SANDBOX=danger-full-access npm run e2e:codex
```

측정 결과:

- `pre-tool-use`: `wrapped`
- `codex-run`: `fold`
- 원본 출력: 133,103자
- 모델에 보인 출력: 1,024자
- 종료 코드: 0
- `sha256:7e4c9a` 보존
- `stable-snapshot` 보존

Codex는 접힌 출력에서 두 값을 모두 찾아 최종 답에 정확히 포함했다.

## S2. retain: 자동 압축 뒤 사실 보존

S1 세션을 `model_auto_compact_token_limit=4000`으로 재개했다.

측정 결과:

- `pre-compact`: `decision: selected`, `trigger: auto`
- 선택 결과: 1개
- 보존 사실: 1개
- 보존 컨텍스트: 1,198자
- simulated Jev 요청: 1회
- `session-start`: `injected`
- rollout 압축: 1회
- 압축 뒤에도 `sha256:7e4c9a`, `stable-snapshot` 모두 보존

## S3. 읽기 게이트

원래 프롬프트를 그대로 실행했을 때 Codex는 다음과 같은 복합 명령을 만들었다.

```sh
sed -n '1,240p' src/core/readgate.mjs && rg ...
```

복합 명령은 현재 단순 읽기 명령 판별 범위 밖이므로 `not_a_sized_read`로 통과했다. 게이트 자체를 검증하기 위해 목적을 먼저 설명한 뒤 아래 명령을 정확히 실행하도록 다시 요청했다.

```sh
cat src/core/readgate.mjs
```

측정 결과:

- 요청 범위: 136줄
- `decision: denied`
- simulated Jev 판정: `p=0.01`
- 개요 항목: 11개
- 거부 사유가 Codex에 명령 차단 오류로 전달됨
- Codex가 개요를 보고 24–63행과 81–94행으로 좁혀 다시 읽음
- 좁힌 읽기는 두 번 모두 `below_threshold`

Codex가 도출한 계산은 다음과 같다.

```text
tail -n +K FILE
from = K
to = total
count = max(0, total - K + 1)
```

같은 세션에서 `cat src/core/readgate.mjs`를 다시 실행하자 `decision: repeated`로 전체 읽기가 허용됐다.

### 관찰된 한계

현재 읽기 게이트는 단순 `cat`, `nl`, `sed`, `head`, `tail` 명령을 대상으로 한다. Codex가 `&&`, 파이프, 여러 파일 등을 포함한 복합 명령을 만들면 `not_a_sized_read`로 통과할 수 있다. `no_intent` 분기는 이번 실행에서 관찰되지 않았다.

## S4. 보고 예산 가드

두 실행은 생성된 표의 문장이 서로 다른 독립 실행이다. 따라서 크기 차이를 동일 본문의 직접 절감률로 해석하지 않는다.

### 가드 켬 — 기본 3,000자

- 첫 `SubagentStop`: `asked_to_shorten`
- 첫 보고: 6,439자
- 원문 아카이브: 생성됨, 6,439바이트
- 두 번째 `SubagentStop`: `already_asked`
- 부모 rollout에 들어온 두 번째 보고: 440자
- 첫 stop부터 두 번째 stop까지: 약 5.48초

추가 턴의 요청 사용량:

| 입력 | 캐시 입력 | 출력 | reasoning 출력 |
| ---: | ---: | ---: | ---: |
| 20,333 | 18,304 | 165 | 59 |

`SubagentStop`의 block은 서브에이전트를 한 턴 더 실행시켰고, 부모는 원문이 아닌 두 번째 짧은 보고를 받았다.

### 가드 사실상 끔 — 100,000,000자

- `SubagentStop`: `within_budget`
- hook이 측정한 보고: 7,108자
- 부모 rollout의 `agent_message`: 7,193자
- 추가 단축 턴 없음

두 크기의 차이는 부모에게 전달되는 메시지 래퍼를 포함했는지 여부에서 생긴다.

## S5. 보고를 줄일 수 있는 지점

### 1. 서브에이전트 도구 호출의 hook

서브에이전트가 다음 명령을 실행하도록 했다.

```sh
sed -n '24,35p' src/core/readgate.mjs
```

이 호출에도 `PreToolUse`와 `PostToolUse`가 발동했다. `PreToolUse` 입력에는 다음 필드가 있었다.

```text
agent_id: <subagent id>
agent_type: default
tool_name: Bash
```

따라서 읽기 게이트는 `agent_id`를 사용해 서브에이전트를 제외할 수 있다. 현재 handler에도 이 제외 동작이 구현되어 있다.

### 2. `SubagentStart.additionalContext`

테스트용 프로젝트 hook에서 다음 표식을 `additionalContext`로 반환했다.

```text
S5_MARKER_9F2D
```

서브에이전트는 최종 답에서 이 표식을 정확히 언급했다. 따라서 `SubagentStart.additionalContext`는 실제 서브에이전트 맥락에 들어가며, 보고 형식 안내를 전달하는 경로로 사용할 수 있다.

이 확인을 위해 임시 프로젝트 hook 설정만 바꿨으며 플러그인 구현 코드는 수정하지 않았다.

### 3. `fork_turns: "all"` 입력 토큰

동일 실행에서 측정한 첫 요청 토큰은 다음과 같다.

| 대상 | 입력 토큰 | 캐시 입력 토큰 |
| --- | ---: | ---: |
| 부모 | 13,399 | 11,264 |
| 서브에이전트 | 18,549 | 11,264 |

서브에이전트 첫 요청은 부모 첫 요청보다 5,150토큰, 약 38.4% 컸다. 이는 단일 실행의 관찰값이며 일반적인 비용 절감 또는 증가율로 일반화하지 않는다.

## 결론

- Codex의 프로젝트 hook에서 prune 감싸기, 자동 압축 retain, 읽기 거부와 재시도, `SubagentStop` 보고 가드가 모두 동작했다.
- `SubagentStop` 차단은 서브에이전트의 추가 턴으로 이어지고, 부모에는 두 번째 보고가 전달된다.
- 서브에이전트 도구 hook 입력의 `agent_id`로 하위 작업을 구별할 수 있다.
- `SubagentStart.additionalContext`로 서브에이전트에 보고 형식을 안내할 수 있다.
- 단순 읽기만 인식하는 현재 read gate는 Codex가 만든 복합 명령을 놓칠 수 있다.
- 라이브 Jev 동작은 이번 실행에서 검증하지 않았다.

## 정리

- 원본 코드와 사용자의 `~/.codex/config.toml`, `~/.codex/hooks.json`은 수정하지 않았다.
- 테스트용 작업공간 두 개는 실행 뒤 삭제했다.
- Codex 표준 rollout과 S4의 합성 보고 아카이브는 `~/.codex/sessions` 아래에 남아 있다.

## 후속 구현 검증 — Jev 파일럿

초기 평가 뒤 Codex에서 의미 판단을 제한적으로 적용할 수 있도록 `JEV_CONTEXT_RETAIN=hybrid`를 추가했다.

- 규칙이 exact-value를 먼저 선택한다.
- 남은 `RETAIN_MAX_CHARS` 예산에서만 Jev가 결정·제약·예외·미해결 위험 청크를 보완한다.
- Jev가 없거나 실패해도 규칙 결과는 유지한다.
- live Jev는 키 존재만으로 켜지지 않으며 `JEV_CONTEXT_JEV=live`를 명시해야 한다.
- Codex 자동 wrapping은 셸 연결·파이프·리다이렉션·치환·여러 줄 명령을 거부한다.

simulated Jev로 다시 실행한 Codex E2E 결과:

| 항목 | 결과 |
| --- | --- |
| prune | 133,103자 → 1,024자, 두 표식과 종료 코드 보존 |
| retain picker | `hybrid` |
| retain | 결과 1개에서 사실 3개, 1,274자, simulated Jev 요청 1회 |
| 압축 | 자동 압축 1회, `SessionStart(compact)` 주입 성공 |
| 압축 뒤 값 | `sha256:7e4c9a`, `stable-snapshot` 모두 보존 |

이 실행은 hybrid 연결과 fallback 구조를 검증한 것이며 live Jev의 의미 판단 품질을 입증한 것은 아니다.
