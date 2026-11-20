# 이슈 #99 결과 — 원본이 사라진 저장 발언 삭제

**Spec:** [설계](../specs/2026-11-20-issue-99-orphaned-saved-utterance-design.md)
**Plan:** [계획](../plans/2026-11-20-issue-99-orphaned-saved-utterance.md)
**브랜치:** `fix/issue-99-orphaned-saved-utterance` (기준 `dev` @ `df20871b`)
**작성일:** 2026-11-20

## 변경

- be: `DELETE /saved-utterances/:id`가 `sav_N`(저장 항목 id)과 `utt_N`(발언 id)를 전체 정규식으로 갈라 지운다.
  그 밖은 404, 형식이 맞는데 없으면 204. `/ids`는 `utterance_id IS NOT NULL`만. Swagger `@ApiParam` 추가.
- fe: `useRemoveSavedUtterance`가 `{ id, utteranceId }`를 받는다. 보관함은 항상 `sav_` id로 지우고 실패 시 오류 토스트
  (데모 차단은 조용히). 회의 화면은 발언 id로 지우며 `as never` 캐스트를 없앴다.

## 재현 (수정 전)

임시 e2e: 저장 후 `DELETE FROM utterance` → `DELETE /saved-utterances/utt_1` 204인데 행 남음,
`DELETE /saved-utterances/sav_1` 404, `/ids` → `{"utterance_ids":[null]}`. 새 e2e 2건과 fe 테스트 3건이
수정 전 실패함을 확인했다(형식 오류 404 테스트는 수정 전에도 통과 — 회귀 고정용).

## 검증

| 명령 | 결과 |
|---|---|
| `npx jest --runInBand --config ./jest.config.js test/saved-utterances.e2e-spec.ts test/get-routes.e2e-spec.ts test/meetings-management.e2e-spec.ts test/demo-read-only.e2e-spec.ts` (be/) | 4 스위트, 47 통과 |
| `npx tsc --noEmit -p tsconfig.build.json` (be/) | 통과 |
| `npx vitest run src/pages/saved-utterances.test.tsx src/features/saved-utterance` (fe/) | 12 통과 |
| `pnpm fe test` | 984 중 983 통과, 1~2건 실패 — 아래 참고 |
| `pnpm fe lint` | 오류 0, 경고 1(`saved-utterance-dashboard.tsx` 기존 `useEffect` 의존성, 변경 전부터 있음) |
| `npx tsc -b --noEmit`, `pnpm fe build` (fe/) | 통과 |

`pnpm fe test`의 실패는 `meeting-live.test.tsx`·`meeting.test.tsx` 중 하나 이상이 실행마다 번갈아 실패한다.
단독 실행 3회는 모두 통과했고, fe/src를 `origin/dev`로 되돌린 상태에서도 전체 3회 중 2회 같은 테스트가 실패했다.
이번 변경과 무관한 기존 flaky로 판단한다. be 전체 스위트는 돌리지 않았다(관련 4 스위트만).

## 완료 기준

| 기준 | 판정 |
|---|---|
| 원본 없는 항목을 `sav_` id로 지우면 204, 행 사라짐 | 충족 (e2e) |
| 원본 있는 항목 `sav_`·`utt_` 양쪽 삭제, 없는 id 204 | 충족 (e2e) |
| `sav_0`·`sav_01`·`sav_1junk`·`abc` 404 | 충족 (e2e, `utt_0` 포함) |
| `/ids`에 `null` 없음 | 충족 (e2e) |
| 보관함 원본 없는 항목 저장 해제 → `DELETE …/sav_N`, 목록에서 사라짐 | 충족 (fe 페이지 테스트) |
| 보관함 삭제 실패 시 오류 토스트 | 충족 (fe 페이지 테스트) |
| ids 캐시에서 빠지고 실패 시 복구 | 충족 (fe 훅 테스트) |
| 테스트·린트·타입 검사 | 부분 충족 — fe 전체 스위트의 기존 flaky 1~2건, be는 관련 스위트만 |
