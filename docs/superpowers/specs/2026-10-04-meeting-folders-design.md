# 회의 폴더 설계

**작성일:** 2026-10-04
**선행:** `dev` @ `8a5edb2`
**대체:** `be/src/database/migrations/028_meeting_tag.sql` 머리 주석의 "폴더 대신 태그를 둔다" 결정 중 일부
(§2.1). 028 파일 자체는 이미 적용된 마이그레이션이라 고치지 않는다.
**범위:** 회의를 폴더 하나에 넣고, 등록할 때 폴더를 고르고, 좌측 내비게이션에서 폴더로 회의 목록을 거른다.

## 1. 목적과 성공 기준

회의가 쌓이면 좌측 회의 목록은 등록 순서로 늘어선 한 줄이 된다. 즐겨찾기와 태그로 거를 수는
있지만, "이 회의는 어느 프로젝트의 것인가"처럼 **회의마다 답이 하나인 기준**을 담을 자리가 없다.
태그로 흉내 내면 한 회의에 프로젝트 태그가 둘 붙는 것을 막을 수 없고, 프로젝트 태그를 안 붙인
회의가 어디에도 속하지 않는다.

성공 기준:

- 모든 회의는 정확히 한 폴더에 들어 있다. 폴더를 고르지 않은 회의는 `기본 폴더`에 들어간다.
- 기존 회의는 마이그레이션 뒤 전부 `기본 폴더`에 있다.
- 새 회의 모달(파일 업로드·실시간 녹음 둘 다)에서 폴더를 고를 수 있다.
- 회의 화면에서 회의의 폴더를 바꿀 수 있다.
- 좌측 내비게이션의 `폴더` 섹션에서 폴더를 누르면 아래 회의 목록이 그 폴더의 회의만 보여 준다.
  즐겨찾기·태그 필터와 함께 걸린다.
- 폴더를 만들고, 이름을 바꾸고, 지울 수 있다. 폴더를 지워도 회의는 지워지지 않고 `기본 폴더`로 옮겨진다.
- `기본 폴더`는 지우거나 이름을 바꿀 수 없다.

## 2. 결정

### 2.1 폴더는 위치, 태그는 분류

028은 "한 회의가 여러 기준에 동시에 걸리므로 한 곳에만 넣는 구조로는 담기지 않는다"는 이유로
폴더를 두지 않았다. 그 관찰은 맞다. 다만 그것은 **분류** 이야기다. 회의가 어디에 **놓이는가**는
기준이 하나다.

그래서 둘을 나눈다:

- **폴더** — 회의가 들어 있는 곳. 회의당 정확히 하나. 프로젝트·고객사·팀처럼 서로 겹치지 않는 묶음.
- **태그** — 회의에 붙는 분류. 회의당 여럿. 유형·상대·주제처럼 겹치는 기준.

태그의 동작(이름으로만 다루고, 안 쓰이면 지운다)은 바꾸지 않는다. 폴더는 반대로 **비어 있어도
남는다**. 폴더는 사용자가 먼저 만들고 나중에 채우는 그릇이기 때문이다.

### 2.2 폴더는 한 단계, 회의당 하나

하위 폴더는 두지 않는다. 좌측 레일 폭(`--rail-nav`)에서 들여쓰기 트리는 금방 잘리고, 트리를
펼치고 접는 상태 관리가 따라붙는다. 회의당 폴더 하나는 `meeting.folder_id NOT NULL` 컬럼 하나로
표현된다. 조인 테이블은 쓰지 않는다.

### 2.3 `기본 폴더`는 실제 행이다

`folder_id`를 NULL로 비워 두고 화면이 NULL을 "기본 폴더"로 그리는 방법도 있다. 이 방법을 쓰면
"폴더가 없는 회의"라는 상태가 하나 더 생긴다. 그러면 모든 필터·카운트·선택 UI가 NULL을 따로
다뤄야 한다. 그래서 `기본 폴더`를 마이그레이션이 만드는 **실제 행**으로 두고 `is_default = true`로 표시한다.

- `is_default` 행은 하나뿐이다. 부분 유니크 인덱스로 DB가 강제한다.
- `기본 폴더`는 지울 수 없고 이름도 바꿀 수 없다. 폴더 삭제가 회의를 옮겨 갈 곳이 늘 있어야 하기 때문이다.
- 회의 INSERT가 폴더를 받지 않으면 `기본 폴더`에 들어간다. 이 규칙은 SQL 함수 `default_folder_id()` 하나에
  두고, 그 함수를 `meeting.folder_id`의 컬럼 DEFAULT로 건다. 컬럼 DEFAULT는 서브쿼리를 받지 않지만 함수 호출은 받는다.
  DEFAULT가 있어야 `folder_id` 없이 `meeting`에 직접 INSERT하는 코드(BE 테스트 수십 곳, worker 테스트 픽스처와
  스모크 스크립트)가 그대로 돈다. 값을 바인딩하는 앱 INSERT는 NULL이 DEFAULT를 건너뛰므로
  `COALESCE($n, default_folder_id())`를 쓴다(`recorded_at`의 COALESCE와 같은 방식).

### 2.4 폴더 삭제는 회의를 옮긴다

`meeting.folder_id`의 FK는 `ON DELETE` 없이(= `NO ACTION`) 둔다. 태그처럼 `CASCADE`를 걸면 폴더
하나를 지우는 순간 녹음·전사·메모가 함께 사라진다. 서비스는 한 트랜잭션에서
`UPDATE meeting SET folder_id = <기본> WHERE folder_id = $1` 다음 `DELETE FROM folder`를 실행한다.
옮기는 단계를 빠뜨리면 FK가 삭제를 거부한다. 회의를 잃는 실수가 DB 단에서 막힌다.

### 2.5 폴더 선택은 목록 필터다

폴더를 누르면 아래 회의 목록이 걸러진다. 폴더 전용 화면(`/folders/:id`)은 만들지 않는다. 지금
좌측 목록은 이미 즐겨찾기·태그로 걸러지는 목록이므로, 폴더도 같은 자리에서 같은 방식으로 건다.

- 선택 상태는 태그 필터와 같이 `LeftNav`의 로컬 상태다. URL에 싣지 않는다.
- 선택한 폴더가 목록에서 사라지면(삭제) 선택이 풀린 것으로 본다. `activeTag`와 같은 처리다.
- 필터는 AND로 걸린다: 폴더 ∧ 즐겨찾기 ∧ 태그.
- 아래 섹션 이름은 `회의 목록`을 유지한다. 폴더를 고르면 이 목록은 "최근 회의"가 아니라 그
  폴더의 회의이기 때문이다. 정렬은 지금처럼 `created_at DESC`이다.

### 2.6 폴더별 회의 수는 FE가 센다

좌측 목록은 이미 `GET /meetings`로 회의 전체를 받는다. 폴더별 회의 수를 그 목록에서 세면 숫자가
보이는 목록과 어긋날 일이 없다. 그래서 `GET /folders`는 회의 수를 주지 않는다. 회의를 옮긴 뒤
`["meetings"]`만 무효화하면 숫자가 따라온다.

## 3. 데이터

`be/src/database/migrations/030_meeting_folder.sql`:

```sql
-- 회의 폴더. 폴더는 회의가 놓이는 곳(회의당 하나), 태그(028)는 회의에 붙는 분류(여럿)다.
-- 기본 폴더는 실제 행이고 지울 수 없다 — 폴더를 지우면 그 회의들은 기본 폴더로 옮겨진다.
CREATE SEQUENCE fld_id_seq;

CREATE TABLE folder (
  id          text PRIMARY KEY DEFAULT 'fld_' || nextval('fld_id_seq')
              CHECK (id ~ '^fld_[1-9][0-9]*$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30 AND name = btrim(name)),
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE fld_id_seq OWNED BY folder.id;
CREATE UNIQUE INDEX folder_name_lower_idx ON folder (lower(name));
CREATE UNIQUE INDEX folder_single_default_idx ON folder ((true)) WHERE is_default;

INSERT INTO folder(name, is_default) VALUES ('기본 폴더', true);

-- 컬럼 DEFAULT는 서브쿼리를 못 받지만 함수는 받는다. folder_id 없이 INSERT하는 코드(테스트·스크립트)는
-- 그대로 기본 폴더에 들어가고, "기본 폴더가 어느 것인가"는 이 함수 한 곳에만 있다.
CREATE FUNCTION default_folder_id() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT id FROM folder WHERE is_default $$;

ALTER TABLE meeting ADD COLUMN folder_id text REFERENCES folder(id) DEFAULT default_folder_id();
UPDATE meeting SET folder_id = (SELECT id FROM folder WHERE is_default);
ALTER TABLE meeting ALTER COLUMN folder_id SET NOT NULL;
CREATE INDEX meeting_folder_idx ON meeting (folder_id);
```

- 폴더 이름 규칙은 태그와 같다: 앞뒤 공백을 다듬고 1–30자, 대소문자를 가리지 않고 하나.
- id는 태그처럼 컬럼 DEFAULT로 채번한다. 시퀀스 이름은 접두사를 따른다(`sav_id_seq`·`spk_id_seq`와 같다).
  `be/src/common/id.ts`의 `nextId`는 파일 저장 전 id가 필요한 회의·화자 전용이라 손대지 않는다.
- 데모 데이터(`demo/seed/damwha-demo.dump`)는 복원 뒤 마이그레이션이 돌면서 전부 `기본 폴더`로
  들어간다. 덤프는 다시 만들지 않는다.

## 4. API

새 모듈 `be/src/folders/`(controller·service·repository). 구조는 `tags/`를 따른다.

| 메서드 | 경로 | 요청 | 응답 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/folders` | — | `[{ id, name, is_default, created_at }]`, 기본 폴더 먼저, 나머지는 `lower(name)` 순 | — |
| POST | `/folders` | `{ name }` | 201, 폴더 | 400 이름 규칙, 409 이름 중복 |
| PATCH | `/folders/:id` | `{ name }` | 폴더 | 400 이름 규칙·기본 폴더, 404, 409 이름 중복 |
| DELETE | `/folders/:id` | — | 204 (회의는 기본 폴더로) | 400 기본 폴더, 404 |

회의 쪽 변경:

- `POST /meetings`(multipart): `folder_id` 필드(선택). 생략과 `''`는 "미지정"이다(`recorded_at`와 같다).
  검증은 `saveFromTemp` **전**, 기존 try 블록 안에서 한다. 실패하면 임시 파일을 지운다.
  없는 폴더는 400 `folder not found`. 경로가 아니라 본문이 가리키는 값이라 404가 아니다.
- `POST /meetings/live`(JSON): `folder_id`(선택). 규칙은 같다. `LiveRepository.createRecording`
  INSERT에 같은 COALESCE를 넣는다.
- `PATCH /meetings/:id`: `folder_id`(string)를 추가한다. `null`은 받지 않는다. 없는 폴더는 400.
  녹음 중인 회의도 옮길 수 있다. 폴더는 처리와 무관한 메타데이터이기 때문이다.
- `GET /meetings`, `GET /meetings/:id`: `SELECT m.*`라 `folder_id`가 그대로 실린다.
- 호출하는 곳이 없는 `MeetingsRepository.create`도 같은 COALESCE로 맞춘다. 회의 INSERT 세 곳이 같은 규칙을 갖게 하기 위해서다.
- 데모 사이트에서는 `DemoReadOnlyGuard`가 POST/PATCH/DELETE를 403으로 막는다. `GET /folders`는 열려 있다.
  따로 할 일은 없다.

## 5. 화면

### 5.1 좌측 내비게이션 (`left-nav.tsx`)

배치 순서: 메뉴 항목 4개 → **`폴더`** → `필터` → `태그` → `회의 목록`.

- 섹션 제목 `폴더` 오른쪽에 `+` 아이콘 버튼(라벨 "새 폴더")을 둔다.
- 첫 항목은 `전체 회의`다. 기본으로 선택되며, 누르면 폴더 선택이 풀린다. 그다음 `기본 폴더`,
  그 뒤에 나머지 폴더(서버 순서)가 온다.
- 각 항목은 `SidebarItem`이고 meta 자리에 회의 수를 보여 준다(§2.6). 선택한 항목은 `active`로 표시한다.
- 기본 폴더가 아닌 항목은 hover·focus 시 `…` 버튼이 보인다. 누르면 Popover가 열려 `이름 바꾸기`와
  `삭제`를 보여 준다.
- 폴더 목록 영역은 `max-h`와 `overflow-y-auto`로 높이를 묶는다(태그 pill의 `max-h-[88px]`와 같은 방식).
  그래야 `회의 목록`이 `flex-1` 공간을 지킨다.
- 빈 목록 문구:
  - 폴더만 걸렸으면 "이 폴더에 회의가 없어요."
  - 태그가 걸렸으면 기존 문구 "이 태그가 붙은 회의가 없어요."
  - 즐겨찾기만 걸렸으면 기존 문구.
  - 둘 이상 걸렸으면 "조건에 맞는 회의가 없어요."

### 5.2 폴더 만들기·이름 바꾸기·삭제

- `FolderNameDialog` 하나를 만들기와 이름 바꾸기에 같이 쓴다. 입력 하나와 저장·취소 버튼이다.
  409는 입력란 아래 "같은 이름의 폴더가 있어요."로 보여 준다.
- 삭제는 확인 Dialog로 묻는다: "'<이름>' 폴더를 지울까요? 안에 있던 회의 N개는 기본 폴더로 옮겨져요."
- 새로 만든 폴더는 바로 선택된다.

### 5.3 새 회의 모달 (`new-meeting-dialog.tsx`)

- 탭 아래, `제목 (선택)` 입력 바로 다음에 `폴더` Select(`shared/ui/select`)를 둔다. 탭 밖이라
  파일 업로드와 실시간 녹음에 모두 걸린다.
- 초기값은 좌측에서 선택한 폴더다. `전체 회의`가 선택돼 있으면 `기본 폴더`다. `LeftNav`가
  `NewMeetingDialog`에 `defaultFolderId`로 넘긴다.
- 폴더 목록을 못 불러오면 Select를 숨기고 `folder_id` 없이 보낸다. 서버가 기본 폴더에 넣는다.
  폴더 조회 실패가 회의 등록을 막지 않게 하기 위해서다.
- 모달 안에서 새 폴더를 만드는 기능은 이번 범위가 아니다(§6).

### 5.4 회의 화면 (`transcript-pane.tsx`)

- 헤더 메타 줄(날짜·길이·참석자·파일) 맨 앞에 폴더 항목을 둔다: 폴더 아이콘 + 폴더 이름.
  `icons.tsx`에 폴더 아이콘이 없으면 추가한다.
- 이 항목은 버튼이다. 누르면 폴더 목록 Popover가 열리고, 고르면 `PATCH /meetings/:id { folder_id }`를 보낸다.
- 성공하면 `["meetings"]`, `["meeting", id]`를 무효화한다. 실패하면 오류 토스트를 띄운다.

### 5.5 FE 데이터

- `api/folders.ts`: `useFolders`, `useCreateFolder`, `useRenameFolder`, `useDeleteFolder`.
  변경 후 `["folders"]`를 무효화한다. 삭제는 `["meetings"]`도 무효화한다.
- `Meeting` 모델과 매퍼에 `folderId`를 추가한다(`api/types.ts`의 wire 타입에 `folder_id`).
- 회의 PATCH mutation이 `folderId`를 받게 넓힌다.

## 6. 범위 밖

- 하위 폴더, 한 회의를 여러 폴더에 넣기
- 드래그 앤 드롭으로 회의 옮기기, 폴더 순서 직접 바꾸기, 폴더 색·아이콘
- 모달의 폴더 Select 안에서 새 폴더 만들기
- `⌘K` 검색, 렌즈 대시보드, 저장한 발언을 폴더로 거르기
- 선택한 폴더를 URL이나 재시작 뒤에도 유지하기
- 기본 폴더 이름 바꾸기

## 7. 테스트

- BE e2e `be/test/folders.e2e-spec.ts`:
  - 목록 순서
  - 만들기, 이름 중복(대소문자 무시) 409
  - 이름 바꾸기, 기본 폴더 이름 바꾸기·삭제 400
  - 삭제 시 회의가 기본 폴더로 옮겨지고 회의 자체는 남는 것
- BE e2e 기존 파일 확장:
  - 업로드: `folder_id` 생략 → 기본 폴더, 지정 → 그 폴더, 없는 폴더 → 400이고 저장 파일이 남지 않음
  - 라이브 시작: 같은 세 경우
  - `PATCH /meetings/:id { folder_id }`
- 마이그레이션: 기존 회의가 있는 DB에 030을 적용하면 전부 기본 폴더로 들어가는 것
- FE:
  - `left-nav.test.tsx`: 폴더 선택 → 목록 필터, 태그와 AND, 삭제된 폴더 선택 해제, 빈 목록 문구
  - `new-meeting-dialog.test.tsx`: 초기값이 선택한 폴더, 업로드·라이브 요청에 `folder_id`가 실림, 폴더 조회 실패 시 Select 없음
  - 회의 화면 폴더 이동 테스트
- 비동기 대기는 고정 sleep 없이 상태 변화를 기다린다.

## 8. 완료 기준

1. 030 적용 뒤 `SELECT count(*) FROM meeting WHERE folder_id IS NULL`이 0이고, 기존 회의는 모두 `기본 폴더`에 있다.
2. 업로드·실시간 녹음 각각 모달에서 고른 폴더에 회의가 들어간다. 고르지 않으면 기본 폴더에 들어간다.
3. 회의 화면에서 폴더를 바꾸면 좌측 폴더별 숫자와 걸러진 목록이 바로 따라온다.
4. 폴더를 지우면 그 안의 회의가 기본 폴더로 옮겨지고, 회의 수는 그대로다.
5. 기본 폴더의 이름 바꾸기·삭제가 거부되고, UI에는 그 메뉴가 없다.
6. 폴더·즐겨찾기·태그 필터가 함께 걸린다.
7. BE·FE 테스트와 typecheck가 통과하고, 실제 앱에서 위 흐름을 한 번씩 확인한다.
