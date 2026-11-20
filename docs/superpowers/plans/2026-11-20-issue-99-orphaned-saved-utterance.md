# 이슈 #99 구현 계획

**Spec:** [원본이 사라진 저장 발언 삭제 설계](../specs/2026-11-20-issue-99-orphaned-saved-utterance-design.md)
**작성일:** 2026-11-20
**기준:** `dev` @ `df20871b`
**검토:** 제안안을 Codex(`gpt-6.1-terra`)가 읽기 전용으로 검토 — "OK with changes". 지적(전체 정규식 검증,
`as never` 제거, Swagger, 캐시·실패 테스트, 보관함 오류 토스트)을 이 계획에 반영했다.

## 1. 회귀 재현 (RED)

- `be/test/saved-utterances.e2e-spec.ts`
  - 원본 없는 항목: `DELETE /saved-utterances/sav_N` → 204, 행 없음. `/ids`에 `null` 없음.
  - 원본 있는 항목: `sav_` 삭제, `utt_` 삭제 각각 → 204, 행 없음. 반복 삭제 204.
  - 형식 오류 `sav_0`·`sav_01`·`sav_1junk`·`abc` → 404.
- `fe/src/pages/saved-utterances.test.tsx`
  - `utterance_id: null` 항목의 "저장 해제" → `DELETE /saved-utterances/sav_4`, 재조회 후 목록에서 사라짐.
  - 삭제 실패 → 오류 토스트.
- `fe/src/features/saved-utterance/api/saved-utterances.test.tsx`
  - `{ id: "sav_1", utteranceId: "utt_2" }` 삭제 → URL은 `sav_1`, ids 캐시에서 `utt_2` 빠짐.
  - 실패 시 `utt_2` 복구.
- 수정 전 실행에서 위 경우가 실패함을 확인한다.

## 2. 수정 (GREEN)

- be service `remove(id)`: `SAVED_ID_RE` → `repo.removeById`, `UTTERANCE_ID_RE` → `repo.removeByUtterance`, 그 밖 404.
- be repository: `removeById` 추가, `remove` → `removeByUtterance` 이름 변경, `savedIdsByMeeting`에 `IS NOT NULL`.
- be controller: DELETE 파라미터 `id`, `@ApiParam` 설명.
- fe 훅: `mutationFn({ id })`, `onMutate`는 `utteranceId`가 있을 때만 ids 갱신.
- fe 보관함: `remove.mutate({ id: item.id, utteranceId: item.utteranceId }, { onError })`.
- fe 회의 화면: 저장/해제 호출을 분기해 `as never` 제거.

## 3. 검증

- `pnpm be test:e2e -- test/saved-utterances.e2e-spec.ts test/get-routes.e2e-spec.ts test/meetings-management.e2e-spec.ts`
- `pnpm fe test`, `pnpm be lint`, `pnpm fe lint`, `pnpm be build`, `pnpm fe build`
- 결과는 `reports/2026-11-20-issue-99-orphaned-saved-utterance-results.md`.
