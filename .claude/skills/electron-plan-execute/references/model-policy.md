# model 정책

Agent 도구의 `model` 파라미터로 넘긴다. 선택지: `haiku`, `sonnet`, `opus`, `fable`.

## Tier별 기본값

| Tier | implementer | verifier | reviewer |
| --- | --- | --- | --- |
| low | sonnet | haiku | sonnet |
| normal | opus | sonnet | opus |
| critical | opus | sonnet | fable |

Task 헤더 `**Model:** implementer=<m> verifier=<m> reviewer=<m>`가 있으면 해당 역할만 덮어쓴다. 명시되지 않은 역할은 Tier 값을 쓴다. Tier도 없으면 에이전트 정의 파일의 `model:`을 쓴다.

## 승급 규칙

수정 루프에서 2회차 리뷰까지 FAIL이면 3회차 reviewer를 한 단계 위 model로 새로 띄운다.

```
sonnet → opus → fable
```

fable에서 FAIL이면 승급 없이 멈추고 사용자에게 보고한다. implementer는 승급하지 않는다 — 컨텍스트 유지가 더 중요하다. implementer 교체가 필요하다고 판단되면 사용자에게 제안한다.

## 제약

- 스위칭 단위는 spawn이다. `SendMessage`로 이어가면 model은 유지된다.
- `subagent_type: "fork"`는 model 오버라이드를 무시한다. 이 하네스의 에이전트는 모두 정의 파일 이름으로 띄운다.
- Phase 마지막 통합 검증 Task는 Tier와 무관하게 reviewer를 `critical`로 취급한다.
