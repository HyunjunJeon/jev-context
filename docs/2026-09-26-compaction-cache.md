# 9/26 압축 × 프롬프트 캐시 실험 (원본 기록)

`context-demo/output/compaction-cache/results.md`를 옮긴 것이다(2026-09-29, 그 폴더를 지우기 전). Claude Code 2.1.283, 원본 fast-jev-compaction(function hook)과 내장 요약을 비교했다. 같은 구성을 이 저장소의 `scripts/e2e-compact.mjs`가 다시 만든다.


Base: 7 turns, last request context 214824 tokens (window 1M, cache TTL 1h, hot). Model: claude-sonnet-5, Claude Code 2.1.283.
Costs are Claude Code list-price estimates (deltas of cumulative total_cost_usd). One run per branch.

| branch | compact time | tokens | follow-up 1 context | follow-up 2 context | cost compact / fu1 / fu2 (total) | values in fu1 answer |
|---|---|---|---|---|---|---|
| none | 0.0s | - | 215883 (write 1059 / read 214822) | 216290 (write 407 / read 215881) | $0.000 / $0.049 / $0.055 ($0.104) | test, seed, bundle, release, rollback (5/5) |
| jev (in-process) | 0.3s | 215520 → 21361 | 67630 (write 43614 / read 24014) | 70379 (write 2749 / read 67628) | $0.000 / $0.189 / $0.028 ($0.217) | test, bundle, release, rollback (4/5) |
| builtin (in-process) | 69.1s | 215520 → 3532 | 33361 (write 9345 / read 24014) | 34829 (write 1468 / read 33359) | $0.153 / $0.056 / $0.017 ($0.226) | test, seed, bundle (3/5) |
| jev (--resume) | 0.3s | 215520 → 21361 | 218374 (write 194358 / read 24014) | 219413 (write 1039 / read 218372) | $0.000 / $0.792 / $0.053 ($0.844) | test, seed, bundle, release, rollback (5/5) |
| builtin (--resume) | 84.8s | 215520 → 5945 | 46219 (write 22203 / read 24014) | 46542 (write 323 / read 46217) | $0.168 / $0.096 / $0.016 ($0.280) | test, bundle, release, rollback (4/5) |
