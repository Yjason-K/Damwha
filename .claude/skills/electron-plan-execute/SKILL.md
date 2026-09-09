---
name: electron-plan-execute
description: Electron macOS 앱 전환 로드맵(docs/electron-migration-roadmap.md)의 "계획 실행" 단계를 돌리는 오케스트레이터. 확정된 Phase 계획(docs/superpowers/plans/*electron-phase-*)의 Task를 순서대로 implementer → verifier → reviewer 서브 에이전트로 처리하고, 차단 지적이 있으면 수정 루프를 돌리며, 결과 문서(docs/superpowers/reports/)에 단계별 기록을 남긴다. "Phase N 계획 실행해줘", "Task 3부터 진행", "electron 계획 실행", "리뷰 루프 돌려줘" 요청 시 반드시 이 스킬을 사용한다. 스펙·계획 작성이나 계획 검증 단계에는 사용하지 않는다 — 그 단계는 메인 세션이 서브 에이전트 없이 진행한다.
---

# electron-plan-execute

로드맵 §5 "계획 실행 — 단계별 리뷰 필수"를 실행하는 절차다. 메인 세션이 오케스트레이터이며, 세 에이전트 정의를 Task마다 새로 띄운다.

| 역할 | 정의 파일 | 기본 model | 편집 권한 |
| --- | --- | --- | --- |
| implementer | `.claude/agents/electron-implementer.md` | opus | 있음 |
| verifier | `.claude/agents/electron-verifier.md` | sonnet | 증거 파일만 |
| reviewer | `.claude/agents/electron-reviewer.md` | opus | 없음 |

역할을 나눈 이유: 로드맵은 "구현 직후의 완료 선언과 구분된 검토"와 "검증 증거 기록"을 요구한다. reviewer는 implementer의 대화를 받지 않으므로 diff와 문서만으로 판단하고, verifier는 판정 없이 기대값·실제값만 남기므로 증거가 판단과 섞이지 않는다.

## 시작 조건

다음이 모두 갖춰졌을 때만 실행한다. 하나라도 빠지면 그 단계로 돌아가라고 사용자에게 알린다.

- 스펙 문서가 리뷰를 통과했고 사용자가 범위를 승인했다.
- 계획 문서가 계획 검증을 통과했고, 각 Task에 `references/plan-task-format.md` 형식의 `Verify`·`Review` 블록이 있다.
- Phase 브랜치 `feat/electron-migration-phase-N-<topic>`가 최신 기본 브랜치에서 만들어져 있다.

## 0. 준비 (Phase당 한 번)

1. Phase worktree를 만든다. `EnterWorktree` 또는 `git worktree add <경로> <브랜치>`. 경로를 `WORKTREE`로 고정한다.
2. worktree에는 gitignore된 파일이 없다. `be/.env`, `fe/.env`, `be/worker/.env`를 원본 작업 디렉터리에서 복사하고, `WORKTREE`에서 `pnpm install`을 실행한다. `be/storage`는 복사하지 않는다 — worktree의 storage는 비어 있는 것이 맞다.
3. Docker DB는 원본과 공유된다. 계획에 마이그레이션이 있으면, 기존 개발 DB에 적용해도 되는지 계획 검증에서 확인된 상태여야 한다. 확인되지 않았으면 멈춘다.
4. 결과 문서를 `references/results-template.md`로 생성한다: `docs/superpowers/reports/YYYY-MM-DD-electron-phase-N-<topic>-results.md`. 증거 디렉터리 `docs/superpowers/reports/evidence/phase-N/`을 만든다.
5. 시작 커밋을 `BASE`로 기록한다.

## 1. Task 루프

계획의 Task를 순서대로 처리한다. Task마다 다음을 반복한다.

### 1-1. model 결정

`references/model-policy.md`의 표를 따른다. 우선순위:

1. Task 헤더의 `**Model:**` 명시 오버라이드
2. Task 헤더의 `**Tier:**` 태그 → 표에서 역할별 model
3. 둘 다 없으면 에이전트 정의의 기본 model

Agent 도구 호출 시 `model` 파라미터로 넘긴다. `subagent_type`은 정의 파일 이름(`electron-implementer` 등)이다. `fork` 타입은 model 오버라이드를 무시하므로 쓰지 않는다.

### 1-2. implementer

Agent 도구로 띄운다. 프롬프트에 반드시 넣을 것: `WORKTREE`, `SPEC`(경로 + 완료 기준 식별자), `PLAN`(경로 + Task 번호), `ATTRIBUTION`(세션의 커밋 attribution 줄). 계획 Task 본문은 경로로 넘기고 복사하지 않는다 — 에이전트가 직접 읽는다.

결과에서 `커밋` 해시를 `HEAD_N`으로, `스펙·계획 충돌`이 "없음"이 아니면 루프를 멈추고 §3으로 간다.

### 1-3. verifier

Agent 도구로 띄운다. 프롬프트: `WORKTREE`, `PLAN`, `COMMIT=HEAD_N`, `EVIDENCE=docs/superpowers/reports/evidence/phase-N/task-N-r<회차>.md`. 회차는 수정 루프마다 1씩 올린다. 이전 증거 파일은 덮어쓰지 않는다.

### 1-4. reviewer

Agent 도구로 띄운다. 프롬프트: `WORKTREE`, `RANGE=<이전 Task의 HEAD 또는 BASE>..HEAD_N`, `SPEC`, `PLAN`, `EVIDENCE`. **implementer의 출력이나 대화를 프롬프트에 넣지 않는다.** 재리뷰일 때만 이전 리뷰 결과 전문과 추가 커밋 범위를 넣는다.

### 1-5. 판정 분기

- `PASS`: 결과 문서에 Task 기록을 쓰고 (§2) 다음 Task로.
- `FAIL`: 수정 루프 (§1-6).
- `SPEC-REVIEW`: §3.

### 1-6. 수정 루프

1. 같은 implementer 에이전트에 `SendMessage`로 차단 지적 목록과 증거의 불일치 항목을 보낸다. 새로 띄우지 않는다 — 구현 컨텍스트를 유지해야 수정이 정확하다.
2. 새 커밋 해시로 `HEAD_N`을 갱신하고 verifier(새 회차) → reviewer(재리뷰)를 다시 돌린다.
3. 회차별 model 승급: 2회차 FAIL 후 3회차 reviewer는 `references/model-policy.md`의 다음 단계 model로 새로 띄운다. implementer는 유지한다.
4. 3회차도 FAIL이면 멈추고 사용자에게 보고한다. 지적 내용, 시도한 수정, 남은 불일치를 요약한다. 4회차를 임의로 돌리지 않는다.

비차단 지적은 수정하지 않고 결과 문서 "후속" 항목에 옮긴다. 승인된 범위 안의 작은 수정은 implementer 판단으로 같이 처리해도 되지만, 그 경우 재리뷰 대상에 포함된다.

## 2. Task 기록

`PASS`마다 결과 문서의 "단계별 실행·리뷰" 표에 한 행을 추가한다: Task 번호, 커밋 범위, 검토자(에이전트 이름 + model), 회차 수, 차단 지적 요약과 조치, 증거 파일 경로, 통과. 후속 항목이 있으면 "후속 작업"에 적는다.

기록을 미루고 다음 Task로 가지 않는다. 컨텍스트가 요약되면 결과 문서가 유일한 진행 상태다.

## 3. 멈춰야 하는 경우

다음이 나오면 루프를 멈추고 사용자에게 확인한다. 임의로 스펙을 고치거나 범위를 줄이지 않는다.

- implementer가 스펙·계획 충돌을 보고했다.
- reviewer가 `SPEC-REVIEW`를 냈다.
- 수정 루프 3회 초과.
- 계획에 없는 마이그레이션·데이터 경로 변경·외부 프로세스 종료가 필요해졌다.
- 수동 검증(`미실행(수동 필요)`)이 완료 기준에 직접 연결된 항목이다. 사용자가 직접 수행하고 결과를 알려줘야 기록할 수 있다.

## 4. Phase 마무리

마지막 Task는 계획상 "Phase 전체 통합 검증"이다. 같은 루프로 처리하되 reviewer model은 `critical` 티어로 올린다. 통과하면:

1. 결과 문서의 "최종 검증"과 "남은 제약·후속 Phase 인계"를 채운다.
2. 로드맵의 해당 Phase 상태와 관련 패키지 `CLAUDE.md`를 갱신하는 Task가 계획에 있어야 한다. 없으면 사용자에게 알린다.
3. PR은 사용자가 지시할 때 연다. 자동으로 열지 않는다.

## 참조

- `references/plan-task-format.md` — 계획 Task가 갖춰야 할 블록. 계획 검증 단계에서도 이 형식을 기준으로 확인한다.
- `references/model-policy.md` — Tier별 model 표와 승급 규칙.
- `references/results-template.md` — 결과 문서 초기 형태.
