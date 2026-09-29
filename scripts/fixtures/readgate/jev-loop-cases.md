# Jev를 Claude Code · Codex 루프 어디에 붙였나

수집일: 2026-09-26. 

한 줄: Jev는 루프 안에서 글을 쓰지 않는다. 이미 있는 후보(스킬, 모델 등급, 도구 출력 조각, 도구 호출, 턴)에 대해 Choice / Noul / Score를 돌려주고, 행동과 권한은 하네스가 정한다.

## 근거를 어떻게 읽나

- 1차: 각 저장소 README, TypeSafe 문서(`docs.typesafe.ai`), TypeSafe 출시글.
- 독립 재구성: Archer Hume, *Jev’s Architecture Unmasked* (2026-09-17, `jev-1.13.0` 프로브). MoE·인과 디코더·포인터 헤드는 저자의 추론이다. 질문 격리, 옵션 순서 효과, `confidence` 계산식은 관측과 공식 어댑터 코드에 가깝다.
- 디렉터리: [awesomejev.com](https://awesomejev.com/) (2026-09-24 스냅샷, 1,094 entries). 스타 수는 관심이지 성숙도가 아니다. 상당수 저장소가 2026-09-17 전후에 생겼다.
- 설치 명령만 반복하는 미러 글(jevtypesafeai.com, jevaiguide.com, systemonemodels.org, jevmanual.com, madewithjev.com, apimaster.ai, redhub)은 목록에 넣지 않았다. 숫자와 “공식” 여부가 저장소와 어긋난다.

TypeSafe가 공개한 계약은 이것이다. `POST https://api.typesafe.ai/v1/systemone`. state 하나와 질문 여러 개를 넣고, 질문마다 Choice / Score / Noul과 확률을 받는다. 입력 $0.042 / 1M tokens, 출력 과금 없음(벤더 표기). 공식 코딩 에이전트 접점은 스킬 `typesafe-ai/skills`이다. TypeSafe 조직의 공식 MCP 서버는 이 수집에서 확인되지 않았다.

## 루프에 넣기 전에 알아둘 모델 성질

실습에서 질문 설계가 갈리는 지점만 적는다.

- 질문끼리는 계산상 격리된다. Hume의 프로브에서 형제 질문에 넣은 비밀 코드는 다른 질문이 0.00으로 못 봤고, 같은 문장을 state에 넣자 0.90–0.92가 됐다. 그래서 “도구 호출 40개에 대해 keep이냐”를 질문 40개로 한 요청에 넣어도, 질문 A의 보기가 질문 B의 답을 바꾸지 않는다.
- 한 질문 안의 보기는 함께 읽힌다. 무관한 보기를 하나 추가하면 기존 두 보기의 상대 확률이 바뀌었다(10블록 모두 같은 방향). 임계값 0.9 근처 정책은 보기 순서를 바꿔 보고 다시 재야 한다.
- 응답의 `confidence`는 “맞을 확률”이 아니다. 공식 파이썬 어댑터는 Choice에 대해 `(p_max - 1/K) / (1 - 1/K)`를 계산한다. 세 보기에서 0.8이면 confidence는 0.7이다. 정책에는 확률을 쓰고, 이 필드를 정확도로 쓰지 않는다.
- 질문이 계산상 독립이어도 통계적으로 독립은 아니다. 확률을 곱해 공동 확신으로 만들지 않는다.
- `output_tokens`는 직렬화된 응답의 과금 카운트다. 생성이 일어났다는 증거가 아니다. 보기 200개와 2개의 서버 시간이 비슷했다(Hume).
- 약 100개 질문까지 서버 시간 증가가 작았다. 컴팩션·가지치기가 “조각마다 Noul 하나”로 설계되는 이유다.
- 실패는 열어 둔다. 이번 수집에서 루프에 들어간 구현은 거의 모두 키 없음, 타임아웃, 이상 응답이면 원래 모델·원래 출력·원래 컴팩션으로 통과시킨다. `jev-guard`만 `JEV_GUARD_FAIL_CLOSED`로 반대로 돌릴 수 있다.

## 붙이는 방식이 세 가지다

같은 “Jev를 붙였다”가 이 셋 중 어디인지에 따라 보장되는 것이 다르다.


| 방식         | 누가 호출하나                 | 루프를 바꾸나                  | 대표                                                                |
| ---------- | ----------------------- | ------------------------ | ----------------------------------------------------------------- |
| Skill      | 모델이 지침을 읽고, 필요할 때 직접 짠다 | 아니다. 설치만으로는 도구 결과가 안 바뀐다 | `typesafe-ai/skills`, `altryne/jevify`                            |
| Tool / MCP | 모델이 도구를 고른다             | 모델이 부르기로 할 때만            | `FrancoisChastel/jev-code`, `jkudish/jev-mcp`, `burnigtm/jev-mcp` |
| Hook / 프록시 | 하네스가 정한 시점에 항상          | 예. 모델 의사와 무관하게 판단이 끼어든다  | 아래 루프 지도의 대부분                                                     |


공식 스킬이 가르치는 일은 “Jev를 부르는 코드를 맞게 짜라”이다. 청중이 원하는 “내 Claude Code 루프가 언제 Jev를 쓰나”는 세 번째 칸이다.

## 루프 위치별 사례

시각은 한 턴의 순서다. 스타는 awesomejev.com 2026-09-24 기준이 있으면 그걸, 없으면 README에 적힌 범위를 적었다.

### 1. 턴이 시작되기 전 — 어떤 모델, 어떤 노력, 어떤 스킬

닫힌 후보 집합이 이미 있다. Jev는 그 집합에서 고른다.


| 사례                                                                                  | 하네스                                                 | 언제                          | 묻는 것                                                                                                       | 측정·한계                                                                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [kerpopule/hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills)       | Hermes 플러그인이 자동. SKILL.md는 Claude Code·Codex에도 들어간다 | 매 턴 직전. 기본은 shadow          | 모델 등급, 스킬(377개 중 하나 또는 none), 검색 결과, 메모리 패시지, 남길 턴                                                         | 라우팅 \~0.4s. 스킬 선택 \~2.8s. 메일 분류 p50 0.44s, 건당 $0.00002(저장소 측정). 위험 단어는 최저 등급으로 안 보낸다. 큰 컨텍스트 한가운데서 더 싼 모델로 안 바꾼다      |
| [onlyjq04/jev-agent-hooks](https://github.com/onlyjq04/jev-agent-hooks)             | Claude Code, Codex, pi. Grok Build는 서브에이전트만         | UserPromptSubmit, 서브에이전트 시작 | 1차: 스킬 명단 Choice + “행동이 필요한가” Noul. 2차: 상위 3개의 SKILL.md 700자와 “이게 그 일인가” Noul. 서브에이전트는 적합 Noul + 등급 Choice | 본인 34턴. fit 0.3이면 스킬 없는 16턴 중 15턴에 제안, 0.7로 올리면 3턴이고 에이전트가 스스로 고른 것과 맞은 것만 남음. Codex는 역할 TOML이 모델·노력을 고정해서 적합 여부만 묻는다 |
| [0xNatoshi/jev-codex-router](https://github.com/0xNatoshi/jev-codex-router)         | Codex 데스크톱·CLI 앞의 로컬 Responses 프록시                  | 모델 호출마다, 도구 이후 계속 호출 포함     | 한 요청에 Choice 넷: 강제 상위 등급이 필요한가, 등급, 생각 깊이, 라우트 임대(한 호출 / 도구 체인 / 유저 턴)                                     | 237턴 과거 시뮬레이션 약 −60%는 옛 정책이고 현재 정책의 절약이 아니다. 저장소가 그렇게 한정한다. shadow 파일, 킬스위치, fail-open은 Astra                         |
| [hussi9/skill-router](https://github.com/hussi9/skill-router)                       | Claude Code 훅 6개                                    | 도구가 돌기 전                    | 설치 스킬 인덱스에 Choice 둘. 0.8 이상이면 라우트, 실패·1.2s 타임아웃이면 로컬 BM25                                                  | 저장소가 말하는 라우팅 정확도 90%, 다단계 30%+ 절감은 저자 수치                                                                              |
| [Dicklesworthstone/skillranker](https://github.com/Dicklesworthstone/skillranker)   | Claude Code 훅, Rust CLI                             | 다음 스텝의 스킬                   | 세션 맥락으로 순위, 기권 가능                                                                                          | ★116. 기권 경로가 있다                                                                                                       |
| [ShivamPansuriya/jev-skill-gate](https://github.com/ShivamPansuriya/jev-skill-gate) | Claude Code `skillOverrides`                        | 세션에서 스킬 매니페스트를 줄일 때         | 설치된 스킬마다 관련성                                                                                               | 저자: 217개에서 12,750 → 3,185 tokens, 세션당 $0.0009                                                                         |
| [bestagentkits/jev-skillful](https://github.com/bestagentkits/jev-skillful)         | Claude Code, Codex, Pi, OMP                         | 프롬프트 훅, 2s 예산               | BM25로 15개까지 줄인 뒤 Choice + 후보별 Noul. 캐시 히트면 250ms 안                                                         | 저자 머신에서 Codex 라이브 세션 주입은 2026-09-19 쿼터 때문에 미검증. 설치만 확인                                                                |
| [JoacoMarc/jev-harness-router](https://github.com/JoacoMarc/jev-harness-router)     | Claude Agent SDK 어댑터                                | 턴마다 한 번, 하드 데드라인            | 등급, effort, 도구, 스킬. 정규식 폴백                                                                                 | ★1. 작다                                                                                                                |


hermes와 jev-agent-hooks가 같은 자리를 다르게 닫는다. hermes는 등급을 실제로 바꾼다(shadow로 시작). jev-agent-hooks의 스킬 제안은 한 줄을 주입할 뿐이고 에이전트가 무시할 수 있다. 실습에서 “붙였다”와 “강제했다”를 나누기 좋다.

### 2. 컨텍스트를 고를 때 — 문서, 패시지, 도구 결과


| 사례                                                                         | 언제                                                | 묻는 것                                                   | 한계                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| hermes Memory / Search                                                     | 검색·기억 회수 직후                                       | 패시지 관련성, 숨은 지시가 있는가, 다음으로 돌릴 후보 쿼리. 쿼리 문장은 Jev가 쓰지 않는다 | 60패시지/요청, 최대 480. 인젝션 스크린은 Jev가 죽어도 로컬에서 돈다. 민감해 보이는 질문은 아예 안 보낸다 |
| [altryne/jevify](https://github.com/altryne/jevify)                        | 긴 문서·시끄러운 도구 출력. 사용자가 Jev를 말하지 않아도 스킬 설명에 트리거가 있다 | 대량 의미 판단을 Jev로 보내고, 추론·종합은 생성 모델이 한다                   | 스킬이다. 설치가 도구 출력을 자동으로 가로채지 않는다                                    |
| TypeSafe 쿡북                                                                | 제품 코드 안                                           | 줄 단위 검색, 재순위, 인용 일치, 스킬 검색, 가드레일                       | 에이전트 루프 가로채기가 아니라, 에이전트가 짤 앱의 패턴                                  |
| [GhalebDweikat/winnow](https://github.com/GhalebDweikat/winnow) 의 prompt 훅 | 프롬프트 시점                                           | 프로젝트 메모리 파일의 관련성. 상위 3개, 8,000자                        | Claude Code 전용. function hook 필요                                  |


### 3. 도구가 돌기 전 — 위험, 범위, 심어진 지시


| 사례                                                            | 하네스                                                            | 언제                                                           | 정책이 사는 곳                                                                                                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [leepokai/jev-guard](https://github.com/leepokai/jev-guard)   | Claude Code, Codex, Copilot, Gemini, Cursor, pi, OpenCode, ACP | PreToolUse와 PostToolUse                                      | 코드에 있다. risk Score 0–3, approval Noul, user\_requested Noul, from\_untrusted Noul. deny는 risk ≥ 2.5 또는 from\_untrusted ≥ 0.7. 사용자가 방금 그 명령을 요청했으면 ask만 allow로 바뀌고 deny는 유지. 읽기 전용 도구는 호출 생략 |
| [shitianfang/jev-use](https://github.com/shitianfang/jev-use) | Claude Code, Codex, pi                                         | 글이 필요 없는 스텝, PreToolUse 게이트                                  | `escalate: true`로 생성 모델에 되돌린다. 저자 측정 p50 \~230ms, 1,000판단당 \~$0.02                                                                                                                          |
| [0x7067/claude-jev](https://github.com/0x7067/claude-jev)     | Claude Code                                                    | UserPromptSubmit 힌트, Task 직전 등급·브리프 검사, 편집 PostToolUse, Stop | 전부 fail-open. 컴팩션은 아래 4번                                                                                                                                                                    |
| [qkal/Canny](https://github.com/qkal/Canny)                   | 코딩 에이전트 훅                                                      | “끝났다”는 주장 앞                                                  | 결정은 결정적 훅, Jev는 조언. 원장에 남긴다                                                                                                                                                                 |


jev-guard가 실습용으로 가장 짧다. `jev-guard check Bash '{"command":"rm -rf ~/"}'` 한 줄로 deny가 나오고, `npm test`는 allow다. 저자가 2026-09-17에 게이트웨이로 잰 표가 README에 있다. Codex는 아직 `ask`가 없어서 ask가 경고로 내려간다. 같은 정책이 하네스마다 다른 권한이 된다.

가드레일은 샌드박스가 아니다. jev-guard README가 그렇게 적는다. Jev의 낮은 위험이 기존 권한 검사를 건너뛰게 하면 안 된다.

### 4. 도구 결과가 돌아온 직후 — 모델이 읽기 전에 자른다


| 사례                                                                | 하네스에서 실제로 가로채나                                                                                                                              | 질문                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [tamaratran/jev-pruner](https://github.com/tamaratran/jev-pruner) | Claude Code: `tool.call`이 Bash stdout를 모델에 넘기기 전에 교체. function hook 필요. Codex 0.152.1은 PostToolUse로 네이티브 출력을 못 바꾼다. 명시적 래퍼 스킬 `$jev-pruner` | 10,000 추정 토큰 이하는 호출하지 않는다. 청크마다 Noul “이 청크에 남아야 할 줄이 있나”. 0.1 이하이고 임계값 미만일 때만 제거. 진단·결과·인식된 소스·diff·JSON은 통째로 보존. 원문은 아카이브하고 푸터에 경로 |
| [GhalebDweikat/winnow](https://github.com/GhalebDweikat/winnow)   | Claude Code `tool.call`로 Read, Bash, Grep. 2.1.260+ function hook                                                                           | 약 25줄 블록마다 “이 블록이 현재 작업에 필요한가”. P &lt; 0.1만 숨김. 0.1–0.5는 불확실해서 유지. 에러로 보이면 아무것도 숨기지 않음. 숨긴 자리는 스텁과 `winnow_recall` 키. shadow 모드가 있다 |
| jev-guard PostToolUse                                             | 위 3번과 같은 프로젝트                                                                                                                               | 결과가 에이전트를 향한 지시인가. injection/canary면 세션에 기억하고, 그 다음 도구 호출의 from\_untrusted에 쓴다                                                      |


Claude와 Codex의 차이가 여기서 가장 선명하다. Claude 실험 훅은 결과 문자열을 바꿔 모델에게 준다. Codex는 같은 질문을 물을 수 있지만, 네이티브 셸 결과를 교체하지 못한다. jev-pruner의 Codex 경로는 스킬을 불러 래퍼로 명령을 다시 실행한다.

winnow는 질문 문구의 효과를 공개했다. 같은 300사례·97개 손 라벨에서 `strict`(”과업과 직접 관련”) 질문의 하위 구간 23%가 실제로는 필요했다. 기본 `structured`는 0.1 미만에서 깨끗했고, 숨기는 양은 텍스트의 약 5%. 실습에서 “좋은가요?”를 쓰면 안 되는 근거로 쓸 수 있다.

### 5. 컨텍스트가 넘칠 때 — 요약 대신 keep / drop


| 사례                                                                                                                                                   | 하네스                                                                                            | 하는 일                                                                                                 | 하지 않는 일                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)                                                                  | Claude Code `session.compact`. 2.1.274 기준 function hook, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | 도구 호출과 결과만 점수. 남기면 원문 그대로. 사용자·어시스턴트 문장은 순서를 유지한 채 손대지 않음. 못 줄이면 내장 요약으로 폴백                          | 요약문을 쓰지 않는다                                                                  |
| [fatelei/jev-compact](https://github.com/fatelei/jev-compact), [leonaaardob/fast-dev-compaction](https://github.com/leonaaardob/fast-dev-compaction) | Codex PreCompact + SessionStart                                                                | Codex 0.155 훅은 컴팩션 결과를 통째로 교체할 수 없다. 내장 요약이 돌고, Jev가 “아직 필요하다”고 한 출력 중 요약이 빠뜨린 것을 다음 요청에 원문으로 다시 넣는다 | Claude 플러그인의 드롭인 대체가 아니다. fast-dev-compaction README는 아이디어 기록에 가깝다고 스스로 한정한다 |
| [compozy/yoshi](https://github.com/compozy/yoshi)                                                                                                    | Claude Code, Codex 앞 프록시                                                                       | 아직 필요한 히스토리인지 판단                                                                                     | POC                                                                          |
| [Nasrallah-AL/jev-cli](https://github.com/Nasrallah-AL/jev-cli)                                                                                      | Claude Code `session.compact`                                                                  | fast-jev-compaction과 같은 절차. 오프라인 `jev compact @session.jsonl`                                        | function hook 필요                                                             |
| hermes “남길 턴”                                                                                                                                        | 트랜스크립트를 고정 길이로 자를 때                                                                            | 71턴을 0.95s에 선택. 최신순 대비 11질문 대 4로 이김(저장소 측정)                                                          |                                                                              |
| hermes 핸드오프                                                                                                                                          | 세션을 넘길 때                                                                                       | 측정 후 기본값을 “Jev 다이제스트”에서 “대화 원문 1,200단어”로 바꿨다. Jev keep/summarize/drop으로 쓴 핸드오프가 평문 트랜스크립트보다 회상이 나빴다  | 컴팩션에 Jev를 쓰는 것과, Jev에게 요약을 시키는 것은 다른 일이다                                     |


공개된 체감 수치(검증된 벤치가 아님): Alex Volkov가 X에서 \~1M → 86K 토큰, 약 1초라고 적었다. 일본어 사용기 하나는 Desktop 세션 187,635 → 33,447토큰, 1.4초([Zenn](https://zenn.dev/orangewk/articles/claude-code-fast-jev-compaction)). 플러그인 기본값은 keepThreshold 0.5, 최근 6메시지 고정, 컨텍스트 60%에서 시도, 줄인 비율이 0.25 미만이면 내장 요약으로 폴백.

function hook은 2026-09-09 Anthropic 이슈 코멘트 기준으로 아직 일찍 바뀌는 표면이다. 일반 청중에게 “설치하세요”로 주기보다, 가로채기 지점의 시연으로 보여주는 편이 맞다.

### 6. AGENTS.md를 지켰는가 — 규칙 문장과 수정이 갈라지는 자리

AGENTS.md를 프롬프트에 넣는 일은 설득이다. 읽고 고치는 모델이 같다. Jev를 끼우는 구현은 그 파일을 통째로 “지켰나?”라고 묻지 않는다. 문장으로 쪼개 둔 규칙마다 Noul 하나를, 방금 생긴 hunk에만 묻는다.

가장 또렷한 구현은 [0x7067/claude-jev](https://github.com/0x7067/claude-jev)다. 출처는 `CLAUDE.md`, 중첩 `AGENTS.md`, `.claude/rules/*`, `.cursor/rules/*`. 파일 해시마다 규칙을 한 번 읽고 캐시한다. 각 규칙의 칸은 종류(코드에 대한 지시인지, 사실·포인터·절차인지), 범위(편집마다인지, 턴 전체인지), 극성(금지인지 요구인지), 대상(import, 주석, 이름, 테스트 등)이다.

편집이 끝나면 순서는 이렇다.

1. 로컬 필터가 hunk가 깰 수 없는 규칙을 뺀다. import 규칙은 import 줄이 없는 수정에 묻지 않는다. 저자 측정으로 검사의 36%가 여기서 빠지고, 중앙값으로 범위 안 14개 중 8개만 질문으로 간다.
2. 일부 대상은 ast-grep으로 저장소를 먼저 본다. hunk만으로는 안 보이는 상수, 동일 양변 assertion, 호출자.
3. 남은 규칙만 한 요청의 Noul. 금지는 “새 코드가 그 짓을 하나”, 요구는 “규칙이 덮는 경우를 더했는데 필요한 요소가 빠졌나”. state는 old→new hunk, 마지막 프롬프트, 주변 줄. 편집당 질문은 최대 40개.
4. 0.80 이상이면 편집을 막고 file:line을 인용한다. 0.50 미만은 침묵. 그 사이는 감싼 함수와 규칙 주변 문장을 더해 한 번 더 묻고, 여전히 애매하면 사람만 본다. 편집의 약 14%가 두 번째 호출을 낸다.
5. “변경은 작게”, “관련 없는 리팩터 금지” 같은 턴 전체 규칙은 편집마다 묻지 않고 Stop에서 그 턴의 hunk 전체에 묻는다. 같은 파일은 세션당 두 번까지만 막고, 그 다음은 표시만 한다.

이 훅은 PostToolUse라서 쓰기는 이미 일어났다. 저자도 “막은 편집을 되돌리지는 않는다”고 적는다. 장점은 롤백이 아니라, 고친 모델이 자기 채점을 못 하고 인용을 받고 다시 쓴다는 점이다. 키 없음과 타임아웃은 fail-open이다.

같은 247개 편집을 v0.23.0에서 다시 점수 매기면 23개(9.3%)가 막힌다. 이 편집들은 당시 통과한 것이라, 막힘은 측정된 오탐 후보이다. 그중 17개는 한 저장소의 “주석 금지”가 실제로 수용된 수정과 충돌한 경우다. 손으로 만든 위반 29개 중 17개가 막히고, 준수한 근접 사례 24개는 0개 막혔다. 라벨은 약하다. 라이브 재측정 지연 중앙값은 0.40초(326호출). 저자가 그렇게 한정한다.

옆에 두면 좋은 대조.


| 사례                                                                             | 묻는 질문                                      | 그래서                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------- |
| [EliaAlberti/jev-rules](https://github.com/EliaAlberti/jev-rules)              | 이 프롬프트에 이 규칙이 해당하나. 규칙마다 Noul, 1초 미만       | 지켰는지가 아니라, 이번 턴에 보여줄 규칙만 고른다. 실패하면 규칙을 전부 보여 준다      |
| [erkamyaman/jev-enforce](https://github.com/erkamyaman/jev-enforce)            | 답과 편집마다 CLAUDE.md 규칙                       | 저자 게시: 검사 348ms, 자기 벤치에서 깨진 규칙의 93.3%. 제3자 재현은 아니다   |
| [rashedInt32/jev-gates](https://github.com/rashedInt32/jev-gates) 의 rule guard | 편집이 CLAUDE.md를 깨나. 기본은 꺼져 있다               | 설명과 규칙이 섞인 실제 CLAUDE.md에서는 위반을 잡기보다 방해가 많았다고 저자가 적는다 |
| [muratcakmak/jev-guard](https://github.com/muratcakmak/jev-guard)              | 정규식으로 끝나는 규칙은 로컬. “토큰이 있는데 색을 하드코딩했나”만 Jev | 패턴으로 결정되는 규칙은 Jev에 안 보낸다                             |
| [leepokai/jev-guard](https://github.com/leepokai/jev-guard) 의 지시 파일 스캔         | AGENTS.md 자체가 설치자가 기대하지 않을 행동을 하나          | 준수 검사가 아니다. 규칙 파일을 의심하는 검사다                          |


장점이 생기는 조건은 규칙이 한 문장으로 갈리고, 극성(금지/요구)과 대상이 있고, hunk가 그 대상을 건드린다는 것이다. AGENTS.md 전문을 한 질문에 넣으면 jev-gates처럼 과잉 차단이 된다. 경로·플래그·정규식으로 끝나는 규칙은 코드에 남긴다.

### 7. 턴이 끝나며 — 근거, “끝”


| 사례                                                                                                                                                           | 언제               | 묻는 것                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [erkamyaman/jev-enforce](https://github.com/erkamyaman/jev-enforce)                                                                                          | 답과 편집마다          | CLAUDE.md를 지켰는가. 348ms·93.3%는 저자 게시                                                                                                                                                       |
| [valentynkit/jev-belay](https://github.com/valentynkit/jev-belay)                                                                                            | Claude Code Stop | 검증 없는 done을 막는다. 트랜스크립트에서 근거를 읽고 Jev를 한 번. 그 외에는 fail-open                                                                                                                                |
| [Nanako0129/stingray](https://github.com/Nanako0129/stingray), [noplan-inc/limpet](https://github.com/noplan-inc/limpet)                                     | Stop             | 아무것도 안 하고 끝난 턴, 예고한 행동을 안 한 턴                                                                                                                                                             |
| [VladyslavHontar/clear-head](https://github.com/VladyslavHontar/clear-head)                                                                                  | Stop             | 이번 세션에서 실제로 읽은 것과 주장이 맞는가                                                                                                                                                                 |
| [valentynkit/jev-commit](https://github.com/valentynkit/jev-commit)                                                                                          | pre-commit       | 메시지가 스테이지 diff와 맞는가, 디버그 잔여, 자격증명                                                                                                                                                         |
| [devagrawal09/jev-review](https://github.com/devagrawal09/jev-review) ★586, [NiazMorshed2007/jev-review](https://github.com/NiazMorshed2007/jev-review) ★218 | 리뷰 워크플로 / MCP    | 패치를 단계적으로 본다. 루프 한가운데의 훅이라기보다 리뷰 제품                                                                                                                                                       |
| LangSmith의 Jev-as-a-Judge                                                                                                                                    | 평가 단계            | “테스트가 통과했는가”와 별도로 “근거가 주장을 받치는가”. 기존 덱이 이 글을 출처로 쓴다: [langchain.com/blog/jev-is-now-available-in-langsmith-evals](https://www.langchain.com/blog/jev-is-now-available-in-langsmith-evals) |


Stop 훅은 15분 실습에 잘 맞는다. 일부러 어설픈 “다 했습니다”를 끝내게 하고, Jev가 트랜스크립트의 근거를 보고 보류하는 한 장면이면 된다.

### 8. 브라우저·컴퓨터 — 루프 옆자리

코딩 루프의 본진은 아니다. “후보는 하네스가 만들고, Jev는 고르기만 한다”의 가장 깨끗한 그림이라 비교용으로 둔다.

- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) ★19,456. 한 요청이 동작과 DOM 요소를 고른다. 글자가 필요할 때만 작은 LLM이 타이핑한다.
- [zurfyx/jev-browser-skill](https://github.com/zurfyx/jev-browser-skill). Claude Code·Codex 스킬. 보기 상한 255 때문에 첫 250개 컨트롤만 제시. HN 로그인→검색 7스텝, 9.3초 중 Jev 2.4초(저자 측정).
- hermes computer/browser use. 이미 안전하다고 판단한 행동 표에서만 고른다. 스크린샷과 필드 값은 안 보낸다. 민감해 보이는 목표는 보내기 전에 거절.

## 실습으로 가져갈 때 구분할 것

루프 안 사례는 네 질문으로 비교하면 된다.

1. 언제 호출되나. 모델이 생각나서가 아니라 훅 이벤트인가.
2. 후보를 누가 만드나. Jev가 문장을 짓지 못하게 후보가 미리 닫혀 있는가.
3. 틀린 확률을 누가 흡수하나. 임계값, 아카이브, fail-open, 사람 ask.
4. 하네스가 그 결과를 실제로 반영할 수 있나. Claude function hook은 교체할 수 있고, Codex 0.15x 훅은 컴팩션·셸 출력을 교체하지 못한다.

데이터가 나가는 범위도 사례마다 다르다. hermes 라우팅은 레드액션한 현재 턴(기본 2,500자)만 보내고 히스토리·파일은 안 보낸다. jev-pruner와 fast-jev-compaction은 대화와 도구 내용을 TypeSafe로 보낸다. jev-guard는 도구 인자 또는 도구 결과만 보낸다고 적는다. 실습 저장소는 공개 픽스처로 하는 편이 맞다.

## 다음에 실습 하나로 좁힌다면

청중이 “언제, 어떻게”를 보게 하려면 설치 튜토리얼보다 아래 둘 중 하나가 맞다.

- 도구 결과 한 건. 일부러 긴 빌드 로그를 주고, 청크마다 Noul을 한 요청으로 물어 남긴 줄과 버린 줄을 보여 준다. jev-pruner의 질문과 보존 규칙(진단은 남긴다, 0.1 이하여야 버린다, 원문은 푸터로 돌아온다)을 그대로 쓰면 된다. function hook 없이도 스크립트로 재현된다. Codex라면 “같은 질문인데 훅이 결과를 못 바꾼다”를 옆에 둔다.
- 도구 호출 한 건. `npm test`와 `rm -rf`와, 웹페이지에 심긴 `curl | sh`를 같은 세션 맥락으로 jev-guard 정책에 통과시킨다. 확률은 모델이 주고, deny/ask/allow는 코드가 정한다는 것이 한 화면에 나온다.

fast-jev-compaction을 행사장에서 처음 설치하는 실습은 빼는 편이 좋다. 실험 플래그, 세션 전체가 외부로 나가는 점, 스타 수와 절감 수치가 아직 서로 다른 출처에 흩어져 있다. 영상이나 토스트 한 장으로 보여주고, 손으로 하는 실습은 위의 작은 질문으로 둔다.

## 출처

- Archer Hume, [Jev’s Architecture Unmasked](https://archerhume.com/posts/jevs-architecture-unmasked/?v=3) (2026-09-17 조사)
- [awesomejev.com](https://awesomejev.com/) / hellogumbo/awesome-jev, 2026-09-24
- [kerpopule/hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills)
- [typesafe-ai/skills](https://github.com/typesafe-ai/skills), [docs.typesafe.ai](https://docs.typesafe.ai)
- [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), [tamaratran/jev-pruner](https://github.com/tamaratran/jev-pruner)
- [fatelei/jev-compact](https://github.com/fatelei/jev-compact), [leonaaardob/fast-dev-compaction](https://github.com/leonaaardob/fast-dev-compaction)
- [leepokai/jev-guard](https://github.com/leepokai/jev-guard)
- [GhalebDweikat/winnow](https://github.com/GhalebDweikat/winnow)
- [0xNatoshi/jev-codex-router](https://github.com/0xNatoshi/jev-codex-router)
- [onlyjq04/jev-agent-hooks](https://github.com/onlyjq04/jev-agent-hooks)
- [altryne/jevify](https://github.com/altryne/jevify)
- [FrancoisChastel/jev-code](https://github.com/FrancoisChastel/jev-code)
- [shitianfang/jev-use](https://github.com/shitianfang/jev-use)
- 그 외 루프 인접 저장소는 본문 표의 링크

