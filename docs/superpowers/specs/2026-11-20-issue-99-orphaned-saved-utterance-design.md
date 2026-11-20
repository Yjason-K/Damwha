# 원본이 사라진 저장 발언 삭제 설계

**작성일:** 2026-11-20
**선행:** `dev` @ `df20871b`
**작업 브랜치:** `fix/issue-99-orphaned-saved-utterance`
**이슈:** #99 (서비스 점검 보고서 FE-7)
**대체:** `2026-08-24-saved-utterances-design.md`의 삭제 계약(§4.3, `DELETE /saved-utterances/:utteranceId`)을
넓힌다. 스냅샷 보존(§2.3, `ON DELETE SET NULL`)은 그대로 둔다.

## 문제

`saved_utterance.utterance_id`는 원본 발언이 지워지면 `NULL`이 된다(마이그레이션 019). 삭제는
`utterance_id`를 키로만 하므로(`saved-utterances.repository.ts` `remove`) 그런 항목은 API로 지울 수
없고, 보관함 화면은 `item.utteranceId && remove.mutate(...)`로 버튼이 아무 일도 하지 않는다.
`GET /saved-utterances/ids`는 그 행의 `null`을 그대로 돌려줘 `string[]` 계약도 깨진다.

### 코드로 확인한 사실

- 지금 앱에는 `utterance` 행을 지우는 경로가 없다. 워커는 재처리 때 옛 버전 발언을 남기고, 회의 삭제는
  저장분까지 CASCADE로 지운다. 즉 `NULL`은 현재 정상 흐름에서 생기지 않지만, 설계상 의도적으로 열어 둔
  상태(향후 보존 정책)다.
- 데모 읽기 전용 가드는 DELETE를 메서드로 막는다(be·fe 둘 다). CLI·share에는 이 API 호출자가 없다.

### 재현 (실행 결과)

e2e로 저장 → `DELETE FROM utterance` 후:

| 요청 | 결과 |
|---|---|
| `GET /saved-utterances` | `[{"id":"sav_1","utterance_id":null}]` |
| `DELETE /saved-utterances/utt_1` | 204, 행 남음 |
| `DELETE /saved-utterances/sav_1` | 404 |
| `GET /saved-utterances/ids?meeting_id=…` | `{"utterance_ids":[null]}` |

## 목표

1. `DELETE /saved-utterances/:id`가 저장 항목 id(`sav_N`)와 발언 id(`utt_N`)를 모두 받는다. 형식은
   `SAVED_ID_RE`/`UTTERANCE_ID_RE` 전체 일치로 가르고, 어느 쪽도 아니면 404. 형식이 맞는데 없는 id는
   지금처럼 204(멱등).
2. `GET /saved-utterances/ids`는 `utterance_id IS NOT NULL`만 돌려준다.
3. 보관함 화면은 항상 저장 항목 id로 지운다. 원본 유무와 상관없이 저장 해제가 동작한다.
4. 보관함의 삭제 실패는 회의 화면과 같은 오류 토스트로 알린다(데모 차단은 조용히).
5. 회의 화면의 저장 해제는 지금처럼 발언 id로 지운다.

## 범위

- be: `saved-utterances.controller.ts`(DELETE 파라미터 `id`, Swagger `@ApiParam`),
  `saved-utterances.service.ts`, `saved-utterances.repository.ts`.
- fe: `useRemoveSavedUtterance`가 `{ id, utteranceId }`를 받는다 — `id`는 URL, `utteranceId`는 ids 캐시
  낙관 갱신용. `saved-utterance-dashboard.tsx`, `transcript-pane.tsx`(`as never` 제거).
- 테스트: be e2e, fe 훅·페이지 테스트.

### 범위 밖

- 삭제 되돌리기(보고서 덧붙임).
- 재처리 뒤 저장분이 옛 버전 발언을 가리키는 문제 — 2026-08-24 설계의 "자동 매칭 안 함" 결정.
- 회의 카드 `saved_count` 캐시 갱신(`["meetings"]` 무효화) — 기존부터 있던 캐시 일관성 문제.

## 대안

`DELETE /saved-utterances/items/:id` 별도 라우트. 두 id 형식이 정규식상 겹치지 않고 기존 호출자
(회의 화면)가 그대로 동작하므로 라우트 하나로 둔다.

## 완료 기준

- [ ] 원본 없는 저장 항목을 `sav_` id로 지우면 204이고 행이 사라진다.
- [ ] 원본 있는 항목도 `sav_`·`utt_` 양쪽으로 지워진다. 없는 id는 양쪽 모두 204.
- [ ] `sav_0`·`sav_01`·`sav_1junk`·`abc`는 404.
- [ ] `/ids`에 `null`이 없다.
- [ ] 보관함에서 원본 없는 항목의 "저장 해제"가 `DELETE /saved-utterances/sav_N`을 부르고 목록에서 사라진다.
- [ ] 보관함 삭제 실패 시 오류 토스트가 뜬다.
- [ ] 원본 있는 항목을 보관함에서 지우면 ids 캐시에서 빠지고, 실패하면 복구된다.
- [ ] `pnpm be test:e2e`(관련 스위트), `pnpm fe test`, `pnpm be lint`, `pnpm fe lint`, 타입 검사 통과.
