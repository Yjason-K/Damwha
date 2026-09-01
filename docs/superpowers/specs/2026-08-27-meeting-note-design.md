# 회의 메모 설계

**작성일:** 2026-08-27
**범위:** 회의당 마크다운 메모 1장의 편집·저장·표시

## 1. 목적과 성공 기준

인사이트 패널의 `메모` 탭은 현재 빈 껍데기다(`fe/src/features/meeting/ui/insight-pane.tsx`의
`Notes()`는 "아직 메모가 없어요" 문구만 그린다). 데이터 레이어도, 서버 테이블도, 엔드포인트도
없다. 이 설계는 그 자리를 실제로 쓸 수 있는 마크다운 메모로 채운다.

사용자가 회의를 들으면서 남기는 것은 전사도 요약도 렌즈도 아닌 **자기 언어로 쓴 글**이다.
전사·요약·렌즈는 모두 파이프라인이 생성하고 재처리가 갈아엎는 데이터인 반면, 메모는 사람이
쓰고 사람만 지운다. 이 비대칭이 아래 설계 결정 대부분의 근거다.

성공 기준은 다음과 같다.

- 메모 탭에서 읽기모드와 편집모드를 오가며 마크다운을 쓰고 본다.
- 타이핑을 멈추면 자동으로 저장되고, 저장 상태가 화면에 드러난다.
- 탭을 옮기거나 화면을 떠나도 마지막 입력이 유실되지 않는다.
- 회의를 재처리해도 메모는 그대로 남는다.
- 회의를 삭제하면 그 회의의 메모도 함께 사라진다.
- 마크다운 렌더링 경로에 raw HTML 주입 지점이 없다.

## 2. 결정

### 2.1 회의당 메모 1장

메모의 단위는 회의다. 한 회의에 여러 장을 두면 목록·정렬·삭제 흐름이 따라붙고, 인사이트 탭
하나가 감당할 UI가 아니게 된다. 회의당 1장이면 탭을 열자마자 곧바로 편집기이고, 스키마는
`meeting_id`에 `UNIQUE` 하나로 끝난다.

전역 메모장(`/notes` 라우트)과 발언 단위 주석은 이번 범위가 아니다. 전자는 회의와 무관한 별도
뷰가 필요하고, 후자는 이미 `saved_utterance`가 차지한 자리에 가깝다.

### 2.2 `processing_version`을 쓰지 않는다

`utterance`, `lens_item`, `meeting_summary`는 모두 회의의 처리 버전에 매여 있다. 재처리가
버전을 올리면 읽는 쪽이 `u.processing_version = m.processing_version`으로 걸러야 하고, 잊으면
낡은 데이터가 새어 나온다.

메모는 이 규칙 **밖**에 있다. 사람이 쓴 글은 오디오를 다시 돌린다고 낡지 않는다. 따라서
`meeting_note`에는 버전 컬럼이 없고, 어떤 읽기 경로도 버전으로 필터하지 않는다. 재처리 후에도
메모는 손대지 않은 채 그대로다.

이는 `saved_utterance`의 스냅샷 전략과도 다르다. 저장한 발언은 원본이 사라질 수 있어 텍스트를
복사해 두지만, 메모는 애초에 원본이 없다. 메모 본문 자체가 원본이다.

### 2.3 빈 본문은 행을 지운다

사용자가 메모를 전부 지우면 서버는 행을 `DELETE` 한다. 결과적으로 "메모 없음" 상태는 **행이
없는 경우 하나뿐**이다.

빈 문자열 행을 허용하면 `null`과 `""` 두 가지 빈 상태가 생기고, 프론트의 빈 화면 분기와 서버의
응답 분기가 둘 다 갈라진다. 얻는 것은 없다 — 사용자에게 "빈 메모가 존재하는 상태"와 "메모가
없는 상태"는 구분되지 않는다.

`CHECK (char_length(body_md) BETWEEN 1 AND 100000)`이 이 불변식을 DB 레벨에서 잡는다.

### 2.4 회의 상세 응답에 임베드하지 않는다

`GET /meetings/:id`는 이미 발화·클러스터·요약을 함께 싣는다. 메모는 여기 넣지 않고
`GET /meetings/:id/note`로 따로 받는다.

이유는 자동저장이다. 메모가 상세 응답의 일부라면 저장할 때마다 `["meeting", id]` 캐시를
건드려야 하고, 그 캐시는 전사 패널 전체가 구독한다. 800ms마다 수백 개 발화 목록이 리렌더되는
구조가 된다. 별도 쿼리 키(`["meeting-note", id]`)로 두면 저장의 영향 범위가 메모 패널 안으로
갇힌다.

`GET /meetings/:id/lenses`가 이미 같은 이유로 별도 fetch이므로, 새로운 패턴을 만드는 것도
아니다.

### 2.5 마크다운 렌더링은 raw HTML을 통과시키지 않는다

`react-markdown`은 기본적으로 HTML을 텍스트로 취급한다. `rehype-raw`를 붙이는 순간에만 HTML이
살아나므로, **붙이지 않는 것**이 곧 방어다. 별도 sanitizer도, `dangerouslySetInnerHTML`도
쓰지 않는다.

링크는 한 겹 더 막는다. 커스텀 `a` 컴포넌트가 `http:`/`https:`로 시작하지 않는 `href`를
버리고(`javascript:` 등), 통과한 링크에는 `target="_blank" rel="noopener noreferrer"`를 붙인다.

### 2.6 에디터는 textarea에 툴바를 얹는다

CodeMirror 6은 번들 ~150KB에 더해 Timbre 토큰을 CM 테마로 다시 옮겨야 한다. tiptap 계열
WYSIWYG는 더 무겁고, 마크다운 왕복에서 서식이 손실된다 — "마크다운 기반"이라는 요구와 방향이
어긋난다.

`<textarea>`에 툴바 버튼과 단축키를 얹으면 두 문제가 다 없다. 툴바가 하는 일은 결국 선택 영역
앞뒤에 문자열을 끼우고 커서를 옮기는 것뿐이므로, 그 로직을 순수 함수로 떼어내면 편집기 자체는
얇게 유지된다.

### 2.7 자동저장 + 명시적 모드 전환

저장은 debounce 자동저장이다(입력 정지 후 800ms). 개인·셀프호스트 단일 사용자 환경이라 동시
편집 충돌이 없고, 저장 버튼을 누르지 않아 글이 날아가는 사고도 없앤다.

모드 전환은 반대로 명시적이다. 읽기모드에서 `편집`을 눌러야 편집기가 열린다. 클릭만으로
편집이 시작되면 렌더된 문서 안의 링크·체크박스와 편집 진입이 섞인다.

## 3. 데이터와 API

### 3.1 스키마

새 migration `be/src/database/migrations/020_meeting_note.sql`:

```sql
CREATE SEQUENCE note_id_seq;

CREATE TABLE meeting_note (
  id          text PRIMARY KEY DEFAULT 'note_' || nextval('note_id_seq')
              CHECK (id ~ '^note_[1-9][0-9]*$'),
  meeting_id  text NOT NULL UNIQUE REFERENCES meeting(id) ON DELETE CASCADE,
  body_md     text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 100000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

- `meeting_id UNIQUE` — 회의당 1장(§2.1).
- `ON DELETE CASCADE` — 회의를 지우는 의도에는 그 회의의 메모도 포함된다.
- 버전 컬럼 없음(§2.2). 별도 인덱스도 없다 — 조회는 항상 `meeting_id` 단건이고 그 유니크
  인덱스가 곧 조회 인덱스다.
- 상한 100,000자는 임의의 안전값이다. 인사이트 레일에 사람이 손으로 쓰는 글의 상한으로
  넉넉하며, 초과 요청은 400으로 끊어 무한 페이로드를 막는다.

### 3.2 엔드포인트

새 모듈 `be/src/notes/` — 기존 도메인 분할(repository=SQL / service=트랜잭션 / controller=HTTP)을
그대로 따른다.

| 메서드 | 경로 | 요청 | 응답 |
| --- | --- | --- | --- |
| `GET` | `/meetings/:id/note` | — | `200 { note: { body_md, updated_at } \| null }` |
| `PUT` | `/meetings/:id/note` | `{ body_md: string }` | `200 { note: { body_md, updated_at } }` / `204` |

응답을 `note` 키로 감싸는 이유는 NestJS 핸들러가 `null`을 반환하면 **빈 본문**이 나가기
때문이다. axios는 그것을 `""`로 받고, 프론트는 "메모 없음"과 "파싱 실패"를 구분할 수 없다.
객체로 감싸면 두 경우 모두 유효한 JSON이 된다.

동작:

- 두 경로 모두 회의가 없으면 `404`.
- `PUT`의 `body_md`가 문자열이 아니거나 100,000자를 넘으면 `400`.
- `PUT`의 `body_md`가 공백만(`btrim` 결과가 빈 문자열)이면 행을 지우고 `204`를 반환한다(§2.3).
- 그 외 `PUT`은 본문을 **있는 그대로** 저장한다. 앞뒤 공백을 다듬지 않는다 — 마크다운에서 줄
  끝 공백 두 칸은 줄바꿈이라 의미가 있고, 트리밍은 사용자가 친 글을 소리 없이 바꾸는 일이다.
  `btrim`은 "지웠는가" 판정에만 쓴다.
- 저장은 `INSERT ... ON CONFLICT (meeting_id) DO UPDATE SET body_md = EXCLUDED.body_md,
  updated_at = now()` 단일 문장이다. 별도 트랜잭션이 필요 없다.

`updated_at`은 응답에만 쓴다 — 낙관적 잠금이나 충돌 감지에는 쓰지 않는다(단일 사용자).

## 4. 프론트엔드

### 4.1 데이터 레이어 — `fe/src/features/meeting/api/notes.ts`

- `useMeetingNote(meetingId)` — `["meeting-note", meetingId]` 쿼리.
- `useSaveMeetingNote(meetingId)` — `PUT` 뮤테이션. `onMutate`에서 캐시를 낙관적으로 갱신한다.
  자동저장이라 서버 응답으로 본문을 되받으면 타이핑 중 커서가 튄다.
- `useAutosaveNote(meetingId)` — 위 둘을 감싸 로컬 draft 상태와 800ms debounce를 관리하고
  `idle | saving | saved | error` 상태를 돌려준다. **언마운트와 탭 전환 시 flush**한다. 이게
  없으면 마지막 타이핑이 debounce 창 안에서 사라진다.

`useDeleteMeeting`의 `removeQueries`에 `["meeting-note", vars.id]`를 추가한다 — 이미
`meeting-status`, `meeting-lenses`가 같은 자리에서 정리되고 있다.

### 4.2 UI — `fe/src/features/meeting/ui/note-pane.tsx`

`NotePane` 하나가 두 모드를 소유한다. `insight-pane.tsx`의 `Notes()`는 이 컴포넌트 호출로
대체된다.

**읽기모드**

- 렌더된 마크다운 + 헤더 우측 `편집` 버튼.
- 본문이 없으면 현재 `Notes()`의 빈 상태(연필 아이콘 + "아직 메모가 없어요")를 그대로 두고
  `메모 쓰기` 버튼을 더한다.

**편집모드**

- 툴바 → `<textarea>` → 하단 `완료` + 저장 상태 텍스트("저장됨 · 방금", "저장 중", "저장 실패").
- 툴바: 굵게 / 기울임 / 제목 / 목록 / 체크박스 / 링크 / 코드.
- 단축키: `⌘B`, `⌘I`, `⌘Enter`(완료), `Esc`(완료).
- 저장 실패 시 재시도 버튼을 같은 줄에 둔다. 실패를 토스트로만 알리면 편집기를 떠난 뒤
  유실을 알게 된다.

**툴바 로직 분리** — `fe/src/features/meeting/lib/md-commands.ts`

각 명령은 `(text, selectionStart, selectionEnd) => { text, selectionStart, selectionEnd }`인 순수
함수다. DOM도 React도 모르므로 단위 테스트가 값 비교로 끝난다. 나중에 "발언 링크 삽입"
(`?u=<utteranceId>`) 같은 명령을 더할 자리도 여기다.

**렌더링**

새 의존성 두 개: `react-markdown`, `remark-gfm`(표·체크박스·취소선). `rehype-raw`는 쓰지
않는다(§2.5).

`@tailwindcss/typography`는 도입하지 않는다. 대신 `components={{ h1, h2, ul, li, code, a, ... }}`
매핑으로 DESIGN.md의 semantic 토큰(`--text-*`, `--surface-*`, `--border-*`)을 직접 적용한다.
플러그인의 자체 색·간격 스케일이 Timbre 토큰과 경쟁하는 상황을 피하고, 의존성도 하나 줄인다.

**아이콘**

`fe/src/features/meeting/ui/icons.tsx`는 `lucide-react`가 아니라 자체 SVG path 맵이다
(`components.json`이 lucide를 가리키지만 실제 설치되어 있지 않다). 툴바 아이콘은 이 맵에 path를
추가한다 — 새 의존성 없음.

### 4.3 레일 너비

`fe/src/index.css`의 `--rail-insight: 320px` → `420px`, 셸(`fe/src/app/app-shell.tsx:106`)의
`min-w-[1160px]` → `1260px`.

레일은 `insight-pane.tsx:595`의 `<aside className="w-[var(--rail-insight)]">`이고 전사 패널과
같은 flex 행에 있으므로, 레일이 넓어지는 만큼 전사가 줄어든다. 최소폭을 100px 함께 올려 최소
창에서 전사 패널이 지금보다 좁아지지 않게 한다.

너비는 탭과 무관하게 항상 420px이다. 탭에 따라 폭이 변하면 탭 전환마다 전사 패널이 리플로우된다.

`DESIGN.md`의 토큰 인덱스에서 `--rail-insight` 항목을 갱신한다(값은 적지 않고 이름만 유지하는
기존 규칙 그대로).

## 5. 테스트

**백엔드**

- 없는 메모 `GET` → `null`.
- `PUT` 신규 생성 / 기존 갱신(같은 `meeting_id`로 두 번 → 행 1개, `updated_at` 증가).
- 공백만 `PUT` → `204`, 행 삭제, 이후 `GET`은 `null`.
- 없는 회의 → `404`. 100,000자 초과 → `400`.
- 회의 삭제 → 메모 CASCADE 삭제.

**프론트엔드**

- `md-commands.test.ts` — 각 명령의 텍스트·커서 결과. 선택 없음 / 선택 있음 / 토글 해제.
- `note-pane.test.tsx` — 빈 상태 렌더, `편집` 진입, 툴바 삽입 반영, `완료`로 읽기모드 복귀,
  저장 실패 시 재시도 노출.
- `notes.test.tsx` — fake timers로 debounce 저장 1회 발생, 언마운트 flush.
- 기존 `insight-pane.test.tsx`의 "탭은 요약·파일·메모 세 개다"는 그대로 통과해야 한다.

## 6. 비목표

- **메모 전문검색.** `search` 모듈은 건드리지 않는다.
- **버전 이력·되돌리기.** 자동저장은 마지막 상태만 남긴다.
- **이미지 첨부.**
- **발언 링크 삽입.** `md-commands.ts`에 자리만 열어 두고 명령은 넣지 않는다.
- **전역 메모 목록 / 발언 단위 주석.** §2.1 참고.
