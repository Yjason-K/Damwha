# 전사 찾기 바 설계 (하단 툴바 정리)

날짜: 2026-08-15
범위: FE 전용 — `transcript-pane.tsx`, `icons.tsx`, `search-field.tsx`,
`pages/meeting.tsx`, `app/app-shell.tsx` + 컴포넌트 테스트. BE 변경 없음.

## 문제

`TranscriptPane`에 동작하지 않거나 중복인 UI가 다섯 개 있다.

**헤더 우측 3개 — 죽은 UI.** `공유` / `더보기` / `저장`(북마크)은 `onClick`이
아예 배선돼 있지 않다(`transcript-pane.tsx:425-437`). 핸들러 미구현이 아니라
클릭해도 아무 일이 일어나지 않는 장식이다. 더불어 `공유`는 제품 원칙과
충돌하고(export/share는 기본 비활성 + 의도적 마찰, 팀 협업은 non-goal),
`저장`은 회의 전체 저장이라는 정의된 적 없는 동작을 암시한다 — 실제 저장은
이미 발화별 버튼(`utterance.tsx:159`)이 담당한다.

**하단 `발언 검색` — 완전한 중복.** `onOpenSearch` → 셸의 `openSearch`로,
좌측 레일 검색 필드가 부르는 것과 **동일한 콜백**이다. `app-shell.tsx:67-69`
주석도 "진입점 둘이 같은 콜백을 공유한다"고 적고 있다.

**하단 `전체 스크롤` — 라벨과 기능 불일치.** 실제 동작은
`scrollTop = scrollHeight`, 즉 전사 맨 아래로 점프다. "전체"가 아니라 "맨 끝".
채팅앱의 "최신으로" 패턴인데 Damwha 전사는 처리 완료된 고정 문서라 맨 끝으로
갈 동기가 없다. 라벨을 고쳐도 살릴 이유가 없다.

반면 **회의 내 검색은 없다.** 2시간짜리 전사에서 특정 단어를 찾으려면 전역
⌘K 팔레트뿐이고, 이건 교차 회의 검색이라 회의 내 탐색 도구로는 맞지 않다.

## 결정 사항 (브레인스토밍 확정)

- **하단 툴바를 인라인 찾기 바로 교체.** 모달 팔레트를 회의 범위로 좁히는
  안은 배제했다 — 모달이 정작 검색 대상인 전사를 덮고, 결과를 고르면 닫혀서
  매칭 여러 개를 훑을 수 없다. 브라우저 Ctrl+F와 같은 위치·같은 조작감이라
  학습 비용이 0이다.
- **클라이언트 사이드 매칭.** 전사는 이미 `meeting.utterances`에 전부
  로드·렌더돼 있어 서버 왕복이 필요 없다. BE `/search`가 `filters.meetingIds`를
  지원하지만(`be/src/search/search.controller.ts:28`) 쓰지 않는다.

  이유: Ctrl+F 의미론은 문자 그대로의 매칭이고, 인라인 하이라이트와 `2/7`
  카운터가 맞으려면 **문자 오프셋**을 알아야 한다. 서버 검색은 FTS + trigram
  유사도라 발화 단위 결과만 주고 오프셋을 주지 않아 하이라이트 위치도
  카운트도 어긋난다. 교차 회의·유사도 검색은 ⌘K가, 회의 내 정확 매칭은 찾기
  바가 맡아 역할이 갈린다.
- **찾기 이동은 오디오를 옮기지 않는다.** `jumpTo`(`meeting.tsx:278`)는
  `?u=`를 세팅해 재생 위치까지 이동시킨다. 매칭 7개를 훑는 동안 오디오가 계속
  튀면 거슬리므로 찾기 이동은 스크롤 + 하이라이트만 한다. 오디오로 가려면
  기존 `원문 보기` 버튼을 쓴다.
- **입력은 항상 보인다** (⌘F로만 여는 토글 아님). 원래 문제가 "쓸모없는 것이
  자리를 차지"였는데 같은 자리를 기능하는 것으로 채우면 세로 공간은 본전이면서
  발견 가능성이 유지된다.

## 구현 설계

### `src/features/meeting/ui/icons.tsx`

`PATHS`에 두 개 추가 (기존 Lucide 계열 24 viewBox 기하와 동일):

- `chevUp: "M6 15l6-6 6 6"` — 기존 `chevDown`의 상하 반전.
- `x: "M6 6l12 12M18 6L6 18"`.

### `src/shared/ui/search-field.tsx`

라이브 입력 변형(`asButton` 아닌 쪽)을 그대로 재사용한다. 한 가지만 보완:
`type="search"`라 WebKit/Blink가 값이 있을 때 네이티브 클리어 버튼을 그려
우리 ✕ 버튼과 겹친다. `base` 클래스에
`[&_input::-webkit-search-cancel-button]:appearance-none`을 추가해 숨긴다.
(레일 쪽은 `asButton`이라 영향 없음.)

`ref`는 별도 작업이 필요 없다 — React 19에서 함수 컴포넌트의 `ref`는 일반
prop이고, `SearchFieldProps`가 `React.ComponentProps<"input">`를 확장하는데
`ref`를 구조분해하지 않으므로 `{...props}`를 타고 `<input>`에 그대로 붙는다.

### `src/features/meeting/ui/transcript-pane.tsx`

#### 제거

- 헤더 우측 `공유` `Button` + `더보기`·`저장` `IconButton` 3개, 그리고 그
  앞의 `<div className="flex-1" />` 스페이서 (425-437행). 우측에 아무것도 남지
  않으므로 스페이서도 함께 사라진다.
- 하단 툴바의 `발언 검색`·`전체 스크롤` 버튼과 `scrollToEnd` 함수.
- 그 결과 고아가 되는 것 — 연쇄를 끝까지 정리한다. `onOpenSearch` prop과
  `TranscriptPaneProps`의 타입, `meeting.tsx:335`의 전달,
  `meeting.tsx:142`의 `useOutletContext<ShellOutletContext>()`와 그 import
  (`useOutletContext`, `ShellOutletContext`)까지.
- **Outlet 컨텍스트 배선 자체를 `app-shell.tsx`에서 제거한다.** 유일한
  소비자가 `meeting.tsx`였으므로, 그것이 사라지면 `ShellOutletContext` 타입 ·
  `outletContext` memo · `<Outlet context={...}>`가 전부 죽은 코드가 된다.
  "나중에 다른 라우트가 쓸 수 있는 공개 계약"으로 남기는 건 요청되지 않은
  유연성이다 (CLAUDE.md 규칙 2·3). `openSearch`는 `LeftNav`가 계속 쓰므로
  평범한 로컬 콜백으로 남기되, `React.useCallback` 래핑은 memo가 사라지면
  필요 없으므로 함께 정리한다. `app-shell.tsx:67-69`의 "진입점 둘" 주석도
  사실이 아니게 되므로 제거한다.
- `icons.tsx`의 `bookmark`는 `left-nav.tsx:164`가 쓰므로 유지. `more` 등
  사용처가 없어지는 아이콘 정의는 건드리지 않는다 (기존 dead code는 범위 밖).

#### 매칭 인덱스

```ts
type FindMatch = { uid: string; start: number; end: number };
```

`meeting.utterances`와 질의로부터 `React.useMemo`로 계산한다.

- 질의는 `trim()` 후 빈 문자열이면 빈 배열.
- 대소문자 무시 — 양쪽 `toLocaleLowerCase()` 후 `indexOf` 루프. 오프셋은 원본
  문자열 기준이므로 인덱스가 그대로 유효하다.
- **전사 실패 발화(`u.status === "transcribe_failed"`)는 건너뛴다.** 화면에
  그려지는 건 `u.text`가 아니라 `"전사하지 못한 구간입니다"`라는 UI 문구다.
  포함시키면 카운트도 틀리고 오프셋이 렌더되지 않는 텍스트를 가리킨다.
- 검색 대상은 발화 텍스트뿐 — 화자 이름·타임스탬프는 제외.
- 순서는 `meeting.utterances` 순서 → 발화 내 오프셋 순. 즉 화면에 보이는 순서.

병합 블록에 대해 별도 처리는 없다. `MERGE_MAX_CHARS`는 병합을 제한할 뿐 표시를
자르지 않으므로 `u.text` 전체가 화면에 있고, 오프셋은 항상 보이는 문자를 가리킨다.

#### 상태

`TranscriptPane` 로컬. 기존 `activeId` 하이라이트와 완전히 독립이다.

- `query: string`
- `cursor: number` — `matches` 내 인덱스. 질의가 바뀌면 0으로 리셋한다
  (렌더 중 prop/state 변화 감지 패턴 — 파일 내 `RenameDialog`의 `wasOpen`과
  동일한 방식으로, effect 안 setState를 피한다).
- `cursor`는 `matches.length`로 감싼다(wrap-around): 마지막에서 다음 → 첫 번째.

#### 하이라이트 렌더

발화별로 자기 매칭을 뽑아 텍스트를 조각내는 헬퍼를 둔다.

```
renderText(text, matchesForThisUtterance, currentMatch) → React.ReactNode
```

- 매칭 없으면 문자열 그대로 반환 (대부분의 발화가 이 경로).
- 매칭 구간은 `<mark>`로 감싼다.
  - 전체 매칭: `bg-[var(--accent-2)] text-[color:var(--accent-text)]`
    — ⌘K 팔레트의 기존 하이라이트(`app-shell.tsx:39`)와 같은 처리.
  - 현재 매칭: `bg-[var(--accent-solid)] text-white` + `data-find-current=""`.
    솔리드 대 틴트라 활성 발화의 `--accent-1` 배경 위에서도 확실히 구분된다.
- `<mark>`의 기본 브라우저 배경을 덮어쓰기 위해 `rounded-[2px]`와 함께 배경을
  명시한다 (팔레트 하이라이트와 동일).
- `Utterance`는 `children: React.ReactNode`를 받으므로 컴포넌트 수정이 없다.
  실패 발화는 지금처럼 문구를 그대로 넘긴다.

#### 현재 매칭으로 스크롤

`cursor`/`matches`가 바뀌면 effect에서
`scrollRef.current?.querySelector("[data-find-current]")`를 찾아
`scrollIntoView({ block: "center" })`. 발화 블록이 아니라 `<mark>` 자체를
기준으로 삼아야 긴 병합 블록에서도 매칭이 화면 중앙에 온다. 포커스는 옮기지
않는다 — 입력에 계속 타이핑할 수 있어야 한다.

기존 `activeId` 스크롤 effect와는 의존성이 달라 서로 트리거하지 않는다. 찾기는
`activeId`를 건드리지 않으므로 URL·오디오도 그대로다.

#### 찾기 바 마크업 (하단 툴바 자리)

```
<div>  ← 기존 하단 툴바 컨테이너의 패딩·배경 유지, flex 한 줄
  <SearchField className="flex-1" placeholder="이 회의에서 찾기"
               value={query} onChange={...} onKeyDown={...} ref={inputRef} />
  {질의가 있을 때만}
  <카운터 />  <IconButton ↑ />  <IconButton ↓ />  <IconButton ✕ />
</div>
```

- **카운터와 버튼은 `SearchField`의 `shortcut` 슬롯이 아니라 형제로 놓는다.**
  `SearchField`의 라이브 변형은 `<label>` 래퍼인데, HTML의 label 콘텐츠 모델은
  대상 컨트롤 외의 interactive content를 금지한다. 버튼을 그 안에 넣으면 유효
  하지 않은 마크업이고, label 활성화 동작이 클릭을 가로채 브라우저별로
  버튼이 안 눌리는 경우가 생긴다. `shortcut` 슬롯은 레일의 `<Kbd>⌘K</Kbd>`
  같은 비대화형 콘텐츠 전용으로 둔다.
- 카운터: 매칭이 있으면 `{cursor + 1}/{matches.length}`, 없으면 `결과 없음`.
  `role="status" aria-live="polite"`로 감싸 변화가 읽히게 한다. 폭이 들쭉날쭉
  하지 않도록 `tabular-nums`, 서체는 툴바 맥락에 맞춰 `text-xs
  text-[color:var(--text-muted)]`.
- ↑/↓는 `IconButton size="sm"`(`chevUp`/`chevDown`), 라벨 `이전 결과`/`다음
  결과`. 매칭 0건이면 `disabled` (기존 `disabled:opacity-40` 처리가 붙는다).
- ✕는 `IconButton size="sm"`(`x`), 라벨 `찾기 지우기` — 질의를 비우고 입력에
  포커스를 되돌린다.

#### 키보드

입력의 `onKeyDown` (전역 리스너 아님 — 다이얼로그와 충돌하지 않는다):

| 키 | 동작 |
|---|---|
| `Enter` | 다음 매칭 |
| `Shift+Enter` | 이전 매칭 |
| `ArrowDown` | 다음 매칭 (`preventDefault`) |
| `ArrowUp` | 이전 매칭 (`preventDefault`) |
| `Escape` | 질의가 있으면 비우기, 없으면 `blur()` |

⌘F/Ctrl+F는 `TranscriptPane`의 `window` keydown effect로 가로채
`inputRef.current?.select()` (기존 질의가 있으면 덮어쓰기 쉽게 전체 선택).
회의 화면에서만 마운트되므로 다른 라우트에는 영향이 없다.

**모달이 열려 있으면 가로채지 않는다.** `document.querySelector('[role="dialog"][data-state="open"]')`가 있으면
그냥 반환한다. ⌘K 팔레트·이름 변경·삭제·화자 확인·재처리 다이얼로그는 Radix
포커스 트랩이 걸려 있어, 뒤에 있는 입력에 `focus()`를 걸면 가드가 되뺏어가며
포커스 싸움이 난다. 이 경우 브라우저 기본 찾기가 그대로 동작하게 둔다.
(`role="dialog"` + `data-state`는 Radix가 항상 세우는 속성이라 내부 구현이
아닌 공개 계약에 기댄다.)

## 엣지 케이스

- **질의가 매칭 0건** → 카운터 `결과 없음`, ↑↓ 비활성, 하이라이트 없음,
  스크롤 없음.
- **입력 중 매칭 수가 줄어듦** (`로터` → `로터스가`) → `cursor`가 질의 변화로
  0으로 리셋되므로 범위를 벗어날 수 없다.
- **회의 전환** — `TranscriptPane`은 `meeting` prop만 바뀌고 리마운트되지
  않을 수 있다. `query`가 남으면 이전 회의의 검색어가 새 전사에 적용된 채로
  보인다. `<TranscriptPane key={meeting.id}>`로 키잉해 상태를 초기화한다
  (`meeting.tsx`의 `<PlayerBar key={meeting.id}>`·`<audio key={meeting.id}>`와
  같은 기존 패턴).
- **전사 실패 발화만 있는 회의** → 매칭 대상이 없어 항상 `결과 없음`. 정상.
- **질의에 정규식 메타문자 포함** (`.`, `*`, `(`) → `indexOf` 기반이라 무해.
  정규식을 쓰지 않는 이유이기도 하다.
- **매칭이 활성 발화(`--accent-1` 배경) 안에 있는 경우** → 현재 매칭은 솔리드
  배경이라 구분된다.
- **⌘K 팔레트로 다른 발화 점프** → `activeId`만 바뀌고 찾기 상태는 그대로.
  두 하이라이트가 공존할 수 있고, 서로 다른 시각 처리라 혼동되지 않는다.

## 테스트

`src/features/meeting/ui/transcript-pane.test.tsx` 신규 (현재 이 파일에 대한
컴포넌트 테스트가 없다). `vitest.setup.ts`가 `scrollIntoView`를 폴리필하므로
목킹해서 호출을 검증한다.

제거 확인:

- `공유`·`더보기`·`저장` 버튼이 헤더에 없다.
- `전체 스크롤`·`발언 검색` 버튼이 없다.

찾기 동작:

- 입력에 매칭되는 단어를 넣으면 `<mark>` 개수가 매칭 수와 같고 카운터가
  `1/n`이다.
- ↓를 누르면 카운터가 `2/n`, `data-find-current`가 두 번째 `<mark>`로 옮겨
  가고 그 요소의 `scrollIntoView`가 호출된다.
- 마지막 매칭에서 ↓ → `1/n`로 순환한다.
- `Shift+Enter`로 이전 매칭, 첫 매칭에서 누르면 `n/n`으로 순환한다.
- 매칭 없는 질의 → `결과 없음`, ↑↓가 `disabled`, `<mark>` 없음.
- 대소문자를 무시하고 매칭한다.
- `transcribe_failed` 발화의 `"전사하지 못한 구간입니다"`는 매칭되지 않는다
  (`구간`으로 검색해도 `결과 없음`).
- `Escape` → 질의가 비워지고 하이라이트가 사라진다.
- 찾기 이동은 `onJump`을 호출하지 않는다 (오디오·URL 불변).
- ✕ → 질의가 비워진다.

기존 테스트(`meeting.test.tsx` 등)는 그대로 통과해야 한다 — 제거 대상 버튼을
참조하는 테스트는 없음을 확인했다.
