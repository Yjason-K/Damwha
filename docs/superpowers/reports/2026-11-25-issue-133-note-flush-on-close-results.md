# 창 닫기·앱 종료 전 메모 flush 결과

**Spec:** [`2026-11-25-issue-133-note-flush-on-close-design.md`](../specs/2026-11-25-issue-133-note-flush-on-close-design.md)
**Plan:** [`2026-11-25-issue-133-note-flush-on-close.md`](../plans/2026-11-25-issue-133-note-flush-on-close.md)
**브랜치:** `fix/issue-133-note-flush-on-quit` (선행 `dev` @ `068eb5d3`)

## 검증 명령과 결과

| 명령 | 결과 |
|---|---|
| `cd fe && pnpm vitest run` | 100 파일, 997 통과 |
| `pnpm --filter damwha-desktop exec vitest run` | 87 파일 통과(1 skip), 1539 통과·3 skip |
| `cd fe && pnpm exec tsc -b` | 오류 없음 |
| `cd desktop && pnpm exec tsc --noEmit -p .` | 오류 없음 |
| `cd fe && pnpm exec eslint <바꾼 fe 파일 4개>` | 경고·오류 없음 |

중간에 `src/design-tokens.test.ts`가 한 번 실패했다. fe 소스 주석의 `#133`을 raw 색(hex)으로 읽었기
때문이다. 소스 주석을 "이슈 133"으로 바꿔 해결했다.

## 변이 검증

수정을 하나씩 되돌리고 테스트를 돌려 실패를 확인한 뒤 원상복구했다.

| 되돌린 것 | 실패한 테스트 |
|---|---|
| `flushPendingNotes`가 `inFlightSaves`를 기다리지 않음 | `flushPendingNotes는 이미 나간 저장도 끝날 때까지 기다린다` |
| 훅이 flush를 `mountedFlushes`에 등록하지 않음 | `flushPendingNotes는 debounce를 기다리지 않고 보내고, PUT이 끝날 때 해결된다` |
| `runQuitFlow`의 flush 호출 삭제 | 9개 (순서 단언 + `sends pending notes before the renderer is replaced…`) |
| `runQuitFlow`의 flush를 `await` 없이 호출 | 8개 (같은 순서 단언들) |
| `runCloseFlow`(녹음 아님)의 flush 삭제 | `closes silently when nothing is recording`, `still closes when the renderer never finishes the flush` |

## 완료 기준 판정

| 기준 | 판정 | 근거 |
|---|---|---|
| C1 debounce 무시 송신 + PUT 뒤 해결 | 충족 | fe 테스트, 변이 2 |
| C2 진행 중인 PUT 대기 | 충족 | fe 테스트, 변이 1 |
| C3 종료 흐름 순서 | 충족 | desktop 순서 단언, 변이 3·4 |
| C4 창 닫기 순서·취소 | 충족 | desktop 테스트, 변이 5 |
| C5 상한·실패 시 계속 | 충족 | 시간 초과·거부 테스트(종료·닫기) |
| C6 실제 앱 ⌘W·⌘Q 실측 | **미실시** | 이 작업에서는 데스크톱 앱을 띄워 키 입력으로 측정하지 않았다. 수정 전 유실 여부와 수정 후 저장 여부 모두 실측이 남아 있다 |

## 남은 것

- C6 실측: dev 앱에서 메모 입력 직후(800ms 이내) ⌘W, ⌘Q를 각각 눌러 재실행 후 메모를 확인한다.
  `supervisor.log`에 `메모 저장이 …ms 안에 끝나지 않았어요`·`메모를 저장하지 못했어요`가 없어야 한다.
- 웹 배포의 탭 닫기(`pagehide`)는 범위 밖이다.
