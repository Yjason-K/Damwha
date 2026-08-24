# 저장한 발언 설계

**작성일:** 2026-08-24  
**범위:** 저장한 발언의 영속 보관, 전역 목록, 발언으로의 복귀

## 1. 목적과 성공 기준

담화의 기본 단위인 발언을 사용자가 나중에 다시 볼 수 있도록 보관한다. 회의 상세의
발언에서 즉시 저장·해제할 수 있고, 좌측 내비게이션의 `저장한 발언`에서 모든 저장분을
확인한다.

성공 기준은 다음과 같다.

- 각 표시 발언 블록에서 `원문 보기` 옆 북마크로 저장 상태를 토글한다.
- 저장 목록은 회의 제목, 화자, 시각, 저장 시점의 발언 텍스트를 보여 준다.
- 목록 항목을 누르면 `/meetings/:meetingId?u=:utteranceId`로 이동하여 기존의
  하이라이트·오디오 seek·접근성 포커스 흐름을 재사용한다.
- 재처리로 현재 발언이 바뀌거나 없어져도 저장 카드의 스냅샷은 남고, 원문 이동만 기존의
  "현재 버전에서 찾을 수 없어요" 안내로 안전하게 실패한다.
- 회의 삭제 시 그 회의의 저장분도 함께 제거된다.

## 2. 결정

### 2.1 서버 영속 저장

브라우저 `localStorage`가 아니라 Postgres에 저장한다. 이 제품은 개인·셀프호스트 환경에서
여러 브라우저와 세션을 오갈 수 있으므로, 기기별 임시 상태는 보관함의 기대와 맞지 않는다.
현재 단일 사용자 모델이므로 사용자 소유자 컬럼이나 인증 계층은 추가하지 않는다.

### 2.2 원본 utterance 단위로 저장

화면은 같은 화자의 연속 발언을 하나의 `UtteranceEntry`로 병합해 표시하지만, 저장의 정체성은
그 블록의 첫 `sources[0].id`인 원본 `utterance.id`로 둔다. 따라서 URL 점프와 기존
`activeId` 처리 규칙을 그대로 쓸 수 있다. 한 표시 블록의 북마크는 해당 대표 원본 발언 하나를
저장하며, 화면이 보인 병합 블록 전체 텍스트를 스냅샷으로 남긴다.

### 2.3 스냅샷 보존과 재처리

`saved_utterance`는 `utterance_id`를 `ON DELETE SET NULL`로 참조하고, 회의 ID도 별도 보존한다.
`text_snapshot`, `speaker_name_snapshot`, `start_ms_snapshot`를 저장하므로 과거 버전의 발언이
정리되거나(향후 보존 정책 변경 포함) 재처리 결과가 달라져도 보관함의 맥락이 사라지지 않는다.
현재 시스템은 구 버전 utterance를 유지하지만, 저장 기능은 그 구현 세부사항에 의존하지 않는다.

회의는 `ON DELETE CASCADE`로 참조한다. 회의를 지우는 사용자의 의도는 그 회의에서 만든
저장분까지 지우는 것으로 해석한다.

## 3. 데이터와 API

### 3.1 스키마

새 migration `019_saved_utterance.sql`이 다음 테이블을 추가한다.

```sql
CREATE SEQUENCE sav_id_seq;
CREATE TABLE saved_utterance (
  id                    text PRIMARY KEY DEFAULT 'sav_' || nextval('sav_id_seq')
                        CHECK (id ~ '^sav_[1-9][0-9]*$'),
  meeting_id            text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  utterance_id          text REFERENCES utterance(id) ON DELETE SET NULL,
  text_snapshot         text NOT NULL,
  speaker_name_snapshot text,
  start_ms_snapshot     int NOT NULL CHECK (start_ms_snapshot >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utterance_id)
);
CREATE INDEX saved_utterance_created_idx ON saved_utterance(created_at DESC, id DESC);
```

`UNIQUE (utterance_id)`는 한 원본 발언을 한 번만 저장한다. `utterance_id`가 `NULL`이 된 오래된
스냅샷 행은 다시 저장할 수 있지만, 그 발언은 현재 화면에 존재하지 않으므로 정상 UI 경로에서는
발생하지 않는다.

### 3.2 HTTP 계약

별도 `saved-utterances` Nest 모듈(repository/service/controller)을 추가한다.

| 메서드 | 경로 | 역할 |
| --- | --- | --- |
| `GET` | `/saved-utterances?limit=…&cursor=…` | 최신 저장순 keyset 페이지 목록 |
| `PUT` | `/saved-utterances/:utteranceId` | 발언 저장. 본문 `text_snapshot`은 현재 표시 블록의 텍스트 |
| `DELETE` | `/saved-utterances/:utteranceId` | 저장 해제 |
| `GET` | `/saved-utterances/ids?utterance_ids=…` | 상세 화면에 보이는 원본 ID들의 저장 여부 |

`PUT`은 `utterance_id`가 유효하고 그 발언이 회의의 현재 `processing_version`이며 `status='ok'`일
때만 허용한다. `text_snapshot`은 trim 뒤 1–4,000자로 검증하고, `speaker_name_snapshot`과
`start_ms_snapshot`은 서버가 해당 발언·화자에서 읽는다. 이미 저장된 경우에도 멱등적으로 같은 저장
행을 돌려준다. `DELETE`는 존재하지 않아도 `204`로 끝내 토글 재시도에 안전하게 한다. ID 형식·커서·
한 번에 조회하는 ID 수는 서비스에서 검증한다.

목록 응답은 카드가 필요한 데이터만 반환한다.

```ts
type SavedUtterance = {
  id: string;
  utterance_id: string | null;
  text: string;
  speaker_name: string | null;
  start_ms: number;
  created_at: string;
  meeting: { id: string; title: string | null; recorded_at: string | null };
};
```

현재 원본 발언이 남아 있으면 목록은 최신 화자 이름도 join해 표시하되, 없으면 스냅샷 이름으로
fallback한다. 이동 버튼은 `utterance_id !== null`일 때만 활성화한다.

## 4. 프런트엔드

### 4.1 저장 토글

`useSavedUtteranceIds(utteranceIds)`와 `useSaveUtterance` / `useRemoveSavedUtterance`를
`features/saved-utterance/api`에 둔다. 쿼리 키는 `['saved-utterance-ids', sortedIds]` 및
`['saved-utterances']`를 쓴다. 토글은 현재 화면의 ID-set과 목록 캐시를 낙관적으로 갱신하고,
실패하면 되돌린 뒤 기존 토스트 스타일로 오류를 알린다.

`TranscriptPane`은 각 병합 블록의 대표 원본 ID와 표시 텍스트를 저장 훅에 넘긴다. `Utterance`는
현재 `원문 보기` 오른쪽에 경량 아이콘 버튼 하나를 렌더한다.

- 비저장: `발언 저장` 라벨의 빈 북마크
- 저장됨: `저장 해제` 라벨의 채워진 북마크
- `원문 보기`와 동일한 hover/focus 노출 규칙, 활성 발언에서는 항상 노출
- 버튼 클릭은 카드의 클릭/점프와 분리해 전파되지 않음

### 4.2 보관함 화면과 라우팅

`/saved-utterances` lazy route와 `pages/saved-utterances.tsx`를 추가한다. `LeftNav`의 기존
placeholder를 이 링크로 바꾸고, 이 경로에서 active 상태를 준다.

화면은 전역 렌즈 대시보드와 같은 셸 폭을 쓰되, 탭·필터는 추가하지 않는다. 헤더는 북마크 아이콘과
`저장한 발언` 제목, 본문은 최신순 카드 목록이다. 각 카드는 다음 순서다.

1. 회의 제목과 녹음 날짜
2. 화자 이름 · `formatClock(start_ms)`
3. 인용 형식의 스냅샷 텍스트
4. 원문 이동 버튼과 저장 해제 버튼

목록은 IntersectionObserver로 다음 페이지를 가져온다. 비어 있으면 "나중에 다시 보고 싶은 발언을
저장해 보세요."를, 오류면 재시도 버튼을 보인다. 무효화된 원본은 카드에 남기되 원문 이동을 disabled로
표시한다.

### 4.3 점프와 삭제

유효 항목의 이동은 `navigate('/meetings/${meetingId}?u=${utteranceId}')`만 호출한다. 이 URL은
기존 `MeetingRoute`의 재생 위치 탐색, transcript scroll/focus, 재처리로 인한 historical guard를
모두 통과하므로 별도 점프 상태를 만들지 않는다. 저장 해제 뒤 보관함 목록에서는 카드를 즉시 제거한다.

## 5. 오류와 경계

- 재처리 중인 발언 또는 없는 발언 저장 요청은 `404`; UI는 오류 토스트 후 낙관 갱신을 복구한다.
- 서버 조회 오류는 이미 저장된 상태를 추측하지 않는다. 버튼은 disabled가 아니라 재시도 가능한 기본
  상태를 유지하되, 요청 실패 시 명확한 toast를 낸다.
- 같은 발언의 빠른 연속 클릭은 mutation pending 동안 해당 버튼을 disabled로 해 중복 요청을 줄이고,
  서버의 unique/idempotent 보장으로 최종 상태를 보호한다.
- `transcribe_failed` 및 silence는 표시·저장 대상이 아니므로 저장 API와 UI 모두 제외한다.

## 6. 검증 계획

TDD 순서로 다음을 구현한다.

1. BE e2e: migration의 FK/unique/cascade, 저장·중복 저장·해제, 최신순 keyset 페이지, 현재 버전
   제약, snapshot fallback을 먼저 실패하는 테스트로 작성한다.
2. FE API 훅: 목록/ID 조회와 save/remove의 캐시 갱신 및 rollback을 MSW 스타일의 테스트로 검증한다.
3. TranscriptPane: `원문 보기` 옆 저장 토글의 label, 저장 상태, 요청, 오류 복구를 검증한다.
4. 저장 화면: 좌측 링크 active 상태, 로딩·빈·오류 상태, 카드 정보, 원문 점프 URL, 삭제 후 즉시 제거,
   무효 원본의 disabled 이동을 검증한다.
5. 패키지별 단위 테스트와 FE build/BE build를 실행하고, migration 포함 BE e2e를 fresh Testcontainers
   DB에서 실행한다.

## 7. 제외 범위

- 태그, 폴더, 메모, 여러 사용자별 저장분
- 저장 목록의 전문 검색/필터/정렬 UI
- 저장분을 재처리 결과의 새 발언에 자동 매칭하는 휴리스틱
- 공유·내보내기

이들은 보관함의 핵심인 "한 번 표시하고, 나중에 정확한 맥락으로 돌아간다"가 안정된 뒤 별도 기능으로
검토한다.
