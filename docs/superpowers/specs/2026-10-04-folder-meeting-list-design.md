# 폴더 회의 목록 화면과 '나' 지정 설계

**작성일:** 2026-10-04
**선행:** `feat/meeting-folders` @ `c537905`
**대체:** `2026-10-04-meeting-folders-design.md` §2.5의 "폴더 전용 화면(`/folders/:id`)은 만들지 않는다".
**범위:** 폴더(또는 전체 회의)를 누르면 가운데 칸에 카드형 회의 목록을 연다. 그 목록의 "내가 참여한 회의"
탭을 위해 화자 하나를 '나'로 지정한다.

## 1. 목적과 성공 기준

지금은 폴더를 누르면 좌측 목록만 걸러지고, 가운데 칸은 보던 회의를 그대로 보여 준다. 폴더 안 회의를
훑어보려면 하나씩 열어 봐야 한다. 회의마다 무엇이 결정됐고 누가 무엇을 맡았는지는 목록에 나오지 않는다.

성공 기준:

- 사이드바 폴더 섹션은 섹션 제목 `전체 회의`와 `+`(새 폴더) 버튼, 그 아래 폴더 행(이름 + 회의 수)으로
  이루어진다. 지금 있는 `전체 회의` 행은 없앤다.
- 폴더 행을 누르면 `/folders/:folderId`로 이동해 가운데 칸에 그 폴더의 회의 목록을 연다. 섹션 제목
  `전체 회의`를 누르면 `/meetings`로 이동해 모든 회의 목록을 연다.
- 목록 화면에는 다음이 있다.
  - 제목(폴더 이름 또는 `전체 회의`)과 회의 수.
  - 탭: `전체 / 내가 참여한 회의 / 결정 있는 회의 / 즐겨찾기`.
  - 정렬: `최신순 / 오래된순 / 긴 회의순`.
  - 한 페이지 20개 페이지네이션과 `표시 중: a–b / 총 N개 회의` 문구.
- 회의 카드는 다음으로 이루어진다.
  - 제목.
  - 메타 줄: 첫 태그 · 날짜·시각 · 길이 · N명.
  - 오른쪽 배지: `결정 N` · `할 일 N` · 저장한 발언 수(🔖). 각 배지는 0이면 숨긴다.
  - `회의 열기 →` 버튼.
  - 미리보기 상자: 결정과 할 일, 또는 요약 첫 문장.
- 화자 관리의 각 화자 행에서 그 화자를 '나'로 지정하거나 지정을 해제할 수 있다. '나'는 최대 한 명이다.
  지정된 화자에는 `나` 배지가 붙는다.
- `내가 참여한 회의` 탭에는 '나'로 지정된 화자가 현재 처리 결과에 등장하는 회의만 나온다. '나'가
  정해지지 않았으면, 화자 관리에서 나를 지정하라는 안내와 그 화면으로 가는 링크를 보여 준다.

## 2. 결정

### 2.1 용어는 `회의`

이미지 시안은 `대화 목록 / 대화 이동`이지만, 앱 전체가 `회의`를 쓴다(`새 회의 기록하기`, `회의 목록`).
그래서 이 화면도 `회의 목록`, `회의 열기`, `내가 참여한 회의`, `결정 있는 회의`로 쓴다.

### 2.2 경로와 사이드바 선택

- 새 경로 `/meetings`(전체)와 `/folders/:folderId`(폴더)를 둔다. 둘 다 같은 `MeetingListPage`를
  `lazyRoute`로 그린다. `/meetings/:meetingId`와는 경로가 겹치지 않는다.
- 사이드바의 폴더 선택(`LeftNav`의 `folderFilter`, 좌측 회의 목록을 거르는 상태)은 남긴다. 폴더를
  누르면 **선택을 바꾸는 동시에 이동한다.** 목록에서 회의를 열어도 좌측은 그 폴더의 회의를 계속 보여
  준다. `전체 회의`를 누르면 선택을 풀고 `/meetings`로 간다.
- 경로가 `/folders/:folderId`면 사이드바 선택이 경로를 따라간다. 주소를 직접 열거나 뒤로 가기를 해도
  좌측 강조와 목록이 가운데 칸과 어긋나지 않는다. 그 밖의 경로에서는 선택을 건드리지 않는다.
- 없는 폴더 id로 들어오면(지워진 폴더 등) 가운데 칸에 "폴더를 찾을 수 없어요"와 `전체 회의` 링크를 그린다.
- `/`는 지금처럼 최신 회의로 넘어간다. 첫 화면을 목록으로 바꾸는 것은 이 작업의 범위가 아니다.

### 2.3 탭·정렬·페이지는 URL 검색 파라미터

`?tab=mine|decisions|fav&sort=oldest|longest&page=N` 형식이다. 기본값(`전체`, `최신순`, 1페이지)은
파라미터를 싣지 않는다. 카드에서 회의를 열었다가 뒤로 가면 보던 탭과 페이지로 돌아온다. 탭이나 정렬을
바꾸면 `page`를 지운다. 범위를 벗어난 `page`는 마지막 페이지로 본다.

정렬 기준은 다음과 같다.

| 정렬 | 기준 | 값이 같을 때 |
|---|---|---|
| 최신순·오래된순 | 회의 시작 시각(`recorded_at`, 없으면 `created_at`) | id |
| 긴 회의순 | `duration_ms`(없으면 0) 내림차순 | 최신순 |

### 2.4 목록 집계는 `GET /meetings`를 넓힌다

사이드바와 목록 화면은 같은 `useMeetings()` 캐시를 쓴다. 데이터는 단일 사용자 로컬이라 회의 수가
수백 개 수준이다. 그래서 전용 엔드포인트나 서버 페이지네이션을 두지 않는다. 대신 `GET /meetings`의
각 행에 카드용 필드를 붙이고, 거르기·정렬·페이지 나누기는 클라이언트에서 한다.

추가 필드(모두 상관 서브쿼리이고, 해당 행이 없으면 0, `false`, `null`):

| 필드 | 정의 |
|---|---|
| `participant_count` | 현재 `processing_version`의 `meeting_cluster` 행 수 |
| `decision_count` | `lens_item`에서 `kind='decision' AND lifecycle_status='active'`인 행 수 |
| `action_count` | 같은 조건에 `kind='action'`인 행 수 |
| `saved_count` | `saved_utterance` 행 수 |
| `has_me` | 현재 `processing_version`의 클러스터 중 `resolved_speaker_id`가 `is_me` 화자인 것이 있는가 |
| `preview_decision` | 활성 결정 중 `created_at, id`가 가장 앞선 것의 `text` |
| `preview_action` | 활성 할 일 하나. `open`을 먼저 고르고 그다음 `created_at, id` 순. `{ text, assignee_name, due_at, done }` 모양 |
| `preview_summary` | `meeting_summary.status='done'`일 때 `segments[0].bullets[0]` |

`due_at`은 `YYYY-MM-DD` 문자열이다. `promise`(약속)는 카드에 내지 않는다. 시안에 없고, 배지가 셋을
넘으면 제목 줄이 좁아진다.

### 2.5 '나'는 `speaker.is_me`

마이그레이션 `031_speaker_is_me.sql`:

```sql
ALTER TABLE speaker ADD COLUMN is_me boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX speaker_single_me_idx ON speaker ((true)) WHERE is_me;
```

`app_setting`에 화자 id를 저장하는 방법은 쓰지 않는다. 그 화자를 지우면 지워진 화자를 가리키는 값이
남기 때문이다. 컬럼으로 두면 화자 삭제와 함께 사라지고, '최대 한 명'은 `folder_single_default_idx`와
같은 부분 유니크 인덱스로 DB가 강제한다.

API는 다음과 같다.

- `PUT /speakers/:id/me` — 한 트랜잭션에서 기존 '나'를 내리고 이 화자를 올린 뒤 화자 행을 돌려준다.
  없는 화자면 404. 등록 상태(`pending`·`provisional` 등)는 따지지 않는다. 회의에서 자동으로 생긴 화자도
  나일 수 있다.
- `DELETE /speakers/:id/me` — 이 화자의 '나' 지정을 푼다. 204를 돌려준다. 없는 화자면 404. 이미 나가
  아니어도 204다(멱등).
- `GET /speakers`·`GET /speakers/:id`는 `s.*`라 `is_me`가 그대로 실린다.
- 데모 빌드에서는 기존 `DemoReadOnlyGuard`와 FE 인터셉터가 비-GET 요청을 막는다. 따로 처리할 것이 없다.

### 2.6 화자 관리 화면

- 화자 행의 `이름 변경`·`삭제` 앞에 ghost 버튼 `나로 지정`을 둔다. 이미 나인 화자에는 `나 지정 해제`를 둔다.
- 나인 화자는 이름 옆에 `나` 배지를 붙인다(`Badge variant="accent"`).
- 성공하면 `["speakers"]`와 `["meetings"]`를 무효화한다. `has_me`가 바뀌기 때문이다. 실패하면 토스트를
  띄우되, 기존 규칙대로 `isDemoBlocked(error)`면 건너뛴다.

### 2.7 카드

- **메타 줄.**
  - 첫 태그 이름: accent 글자색. 태그가 없으면 생략한다.
  - 날짜: 오늘이면 `오늘 HH:MM`, 어제면 `어제 HH:MM`, 그 밖은 `M월 D일`, 해가 다르면 `YYYY년 M월 D일`.
  - 길이: 기존 `dur`. 길이를 모르면 생략한다.
  - `N명`: `participant_count`가 0이면 생략한다.
- **배지.** 처리가 끝나지 않은 회의(`recording`·`uploaded`·`processing`·`failed`)는 집계 배지 대신 사이드바와
  같은 상태 배지를 단다.
- **미리보기 상자.** 최대 두 줄이고, 둘 다 없으면 상자를 그리지 않는다.
  1. 결정 줄(초록 체크 아이콘): `preview_decision`.
  2. 할 일 줄(주황 체크 아이콘): `담당자 · M월 D일까지 본문` 꼴이다. 담당자와 기한은 있는 것만 붙인다.
     할 일이 없으면 이 자리에 요약 줄(줄 아이콘, muted)을 넣는다.
- 카드 제목과 `회의 열기 →` 버튼은 둘 다 `/meetings/:id`로 가는 링크다. 카드 전체를 버튼으로 만들지
  않는다. 링크 안에 링크를 넣지 않기 위해서다.

### 2.8 빈 상태

| 상황 | 문구 |
|---|---|
| 폴더가 비었음 | 이 폴더에 회의가 없어요. |
| 탭 결과가 없음 | 조건에 맞는 회의가 없어요. |
| 나 미지정 + `내가 참여한 회의` | 화자 관리에서 '나'를 지정하면 내가 참여한 회의만 모아 볼 수 있어요. + `화자 관리로 가기` 링크 |
| 로딩 | 기존 `CenterState`의 스피너 |
| 오류 | 기존 `CenterState`의 다시 시도 |

## 3. 변경 범위

**BE**

- `be/src/database/migrations/031_speaker_is_me.sql`
- `be/src/meetings/meetings.repository.ts`: `list`에 §2.4의 필드를 추가한다.
- `be/src/speakers/speakers.{controller,service,repository}.ts`: `PUT`·`DELETE /speakers/:id/me`.
- 테스트: 기존 `be/test`의 meetings·speakers e2e 파일에 추가한다.

**FE**

- `fe/src/features/meeting/api/{types,mappers}.ts`: 와이어 필드와 `MeetingSummary` 확장.
- `fe/src/pages/meeting-list.tsx`: 새 파일. 카드는 `features/meeting/ui/meeting-card.tsx`로 뺀다.
- `fe/src/app/router.tsx`: 두 경로를 추가한다.
- `fe/src/features/meeting/ui/folder-section.tsx`, `left-nav.tsx`: 섹션 제목, 이동, 경로 동기화.
- `fe/src/features/speaker/api/speakers.ts`, `ui/speaker-row.tsx`: `isMe`, 지정·해제.
- 테스트: 목록 화면, 폴더 섹션 이동, 화자 행 지정·해제.

## 4. 범위 밖

- 첫 화면(`/`)을 목록으로 바꾸는 것.
- 서버 페이지네이션과 검색.
- 약속(promise) 배지.
- 회의 상세의 참석자 목록에 '나'를 표시하는 것.
