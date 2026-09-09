# 계획 Task 형식

electron-plan-execute가 파싱하는 최소 구조다. 계획 검증 단계에서 모든 Task가 이 형식을 갖췄는지 확인한다. 기존 계획(`docs/superpowers/plans/2026-09-*`)의 `**Files**` / `**Interfaces**` / Step 체크박스 구조는 그대로 써도 되고, 아래 블록을 추가하면 된다. 헤더의 `superpowers:executing-plans` 안내 줄은 넣지 않는다.

```markdown
### Task N: <제목>

**Tier:** low | normal | critical
**Model:** implementer=opus reviewer=fable        ← 선택. Tier보다 우선.
**Spec:** <완료 기준 식별자 목록, 예: P1-C2, P1-C3>
**Depends:** Task N-1                             ← 선택.

**Files**
- Create / Modify / Test: ...

**Interfaces**
- ...

**Steps**
- [ ] ...

**Verify**
| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `pnpm be test -- live-audio` | exit 0, 신규 spec 3건 통과 |
| V2 | `<repo root>` | `pnpm fe build` | exit 0 |
| V3 | 수동 | 앱 아이콘으로 실행 후 업로드 화면 진입 | 화면 표시 |

**Review**
- [ ] `process.cwd()` 의존 없음
- [ ] 종료 경로에서 자식 프로세스 정리 호출 확인
- [ ] 스펙 P1-C2의 "..." 조건이 코드로 존재

**Rollback**
- <위험 변경일 때만. 예: 마이그레이션 되돌리기 명령, 설정 원복 절차>
```

규칙:

- `Verify`의 명령은 verifier가 그대로 실행한다. 사람이 읽는 설명이 아니라 실행 가능한 명령을 쓴다. cwd는 CLAUDE.md 규칙대로 루트 또는 `--filter`/`--directory`로 지정한다.
- `기대`는 종료 코드나 출력의 결정적 문자열처럼 비교 가능한 값으로 쓴다. "정상 동작"은 기대값이 아니다.
- 수동 검증은 cwd 칸에 `수동`이라고 쓴다. 완료 기준에 직접 연결된 수동 검증은 사용자가 수행해야 하므로 되도록 마지막 통합 Task에 모은다.
- `Review`는 reviewer가 항목별로 확인하는 체크리스트다. 스펙 조항을 코드로 확인하는 항목을 포함한다.
- `Tier`: 문서·설정·단순 배선은 `low`, 일반 구현은 `normal`, 프로세스 수명·데이터 안전·계약 변경·통합 검증은 `critical`.
