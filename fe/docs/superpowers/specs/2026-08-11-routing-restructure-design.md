# 라우팅 구조 개편 설계

_2026-08-11 · 루트 랜딩 제거, URL 기반 셸 레이아웃으로 전환_

## 배경

현재 라우터(`src/app/router.tsx`)는 여섯 개의 평면 라우트다.

| 경로 | 컴포넌트 | 성격 |
|------|----------|------|
| `/` | `HomePage` | "Damwha" 제목 + 시작하기 버튼 → `/app` |
| `/app` | `MeetingPage` | 3분할 browse 셸 |
| `/speakers` | `SpeakersPage` | 셸 밖 독립 전체 페이지 |
| `/settings` | `SettingsPage` | 셸 밖 독립 전체 페이지 |
| `/showcase` | `ShowcasePage` | 디자인 시스템 데모 |
| `*` | `NotFoundPage` | 404 |

두 가지 문제가 있다.

**첫째, `/` 랜딩은 개념 정의서와 어긋난다.** `docs/product-concept.md`는
"browse-first shell, search always present — 검색 전용 홈은 두지 않는다"를
명시한다. 지금의 `/`는 내용이 없는 클릭 한 번짜리 관문이다.

**둘째, 셸의 화면 상태가 전부 React state라 주소에 남지 않는다.**
`MeetingPage`(604줄)는 선택된 회의(`selectedId`), 뷰 전환(`view`), 렌즈
종류(`lens`), 하이라이트된 발언(`activeId`)을 모두 컴포넌트 state로 들고
있다(`pages/meeting.tsx:167-184`). 그 결과:

- 새로고침하면 항상 목록 첫 회의로 리셋된다.
- 브라우저 뒤로가기가 회의 전환을 되돌리지 못한다.
- 특정 회의나 발언을 북마크·공유할 수 없다. 개념 정의서가 제품의 시그니처
  기능으로 규정한 **utterance-jump**의 결과가 주소에 남지 않는다.

랜딩 제거는 파일 두 개를 지우는 일이지만, 그 김에 두 번째 문제를 함께
푸는 것이 이 설계의 실질이다.

## 목표 / 비목표

**목표**

- `/` 랜딩 제거. 루트가 곧 browse 셸이 된다.
- 회의 선택과 발언 하이라이트를 URL로 표현해 새로고침·뒤로가기·북마크가
  정상 동작하게 한다.
- 화자 관리·처리 설정을 셸 안으로 들여 회의 목록 레일이 끊기지 않게 한다.
- 위 변경으로 불필요해지는 수동 상태 동기화 코드를 걷어낸다.

**비목표**

- 인사이트 탭·회의 목록 필터의 URL 반영. 개인용 도구에 URL이 지저분해지고
  히스토리가 쌓이는 대가가 이득보다 크다.
- 오디오 재생 위치의 URL 반영.
- 화면 전환을 가로지르는 재생 지속(아래 "결정 사항" 참조).
- `/showcase` 정리. 제품 표면이 아니고 이번 요청과 무관하다.
- 반응형 대응. `DESIGN.md` 5장대로 데스크톱 전용을 유지한다.

## 결정 사항

| 항목 | 결정 | 근거 |
|------|------|------|
| 회의 선택 | `/meetings/:meetingId` 경로 파라미터 | 딥링크·뒤로가기 |
| 발언 하이라이트 | `?u=<utteranceId>` 쿼리 | 점프 결과 복원 |
| 렌즈 대시보드 | `/lenses/:kind` | `view` state 대체 |
| 루트 `/` | 목록 첫 회의로 `replace` 리다이렉트 | browse-first |
| 화자·설정 | 셸 레이아웃 안 | 맥락 유지 |
| 오디오 소유 | 회의 뷰 (레이아웃 아님) | 아래 참조 |
| 셸 레이아웃 | flex 중첩 → CSS Grid 2열 2행 | 아래 참조 |
| 탭·필터 | state 유지 | YAGNI |

### 오디오를 레이아웃이 아니라 회의 뷰가 소유한다

레이아웃이 오디오를 소유하면 설정·화자 화면에서도 재생이 이어지지만,
레이아웃이 "현재 회의"를 알아야 하고 회의 뷰와 상태를 나눠 갖게 되어
context가 하나 더 생긴다. 개인용 도구에서 "설정을 만지며 녹음을 듣는"
시나리오는 실재하지 않는다고 판단해 회의 뷰가 소유한다. 결과적으로
`PlayerBar`와 `<audio>`는 `/meetings/:meetingId`에서만 마운트된다.

### 셸을 CSS Grid로 재구성한다

`PlayerBar`의 트랜스포트 블록은 `w-[calc(var(--rail-nav)-20px)]`
(`player-bar.tsx:112`)로 **재생 버튼이 LeftNav 레일 아래에 정렬**되도록
설계돼 있다. 즉 PlayerBar는 LeftNav 옆이 아니라 아래를 가로지르는 전체 폭
행이다. 그런데 회의 뷰는 LeftNav *옆* 칸에 들어가므로, "뷰가 소유하되 전체
폭"을 flex 중첩으로는 표현할 수 없다.

`<Outlet/>`은 래퍼 DOM 없이 매칭된 라우트 엘리먼트를 그대로 렌더하므로,
셸을 그리드로 두고 회의 뷰가 Fragment로 두 조각을 반환하면 **둘 다 그리드의
직계 자식**이 되어 각자 셀을 차지한다. portal이나 context 없이 순수 CSS로
해결되고 레일 정렬도 보존된다.

```
grid-cols-[var(--rail-nav)_minmax(0,1fr)]
grid-rows-[minmax(0,1fr)_auto]

┌──────────┬──────────────────────┐
│ LeftNav  │ <Outlet/>            │  row 1
├──────────┴──────────────────────┤
│ PlayerBar (col-span-2)          │  row 2 — 회의 뷰만 렌더
└─────────────────────────────────┘
```

row 2는 `auto`이므로 PlayerBar를 렌더하지 않는 화면에서는 높이 0으로 접힌다.

## 라우트 트리

```
/                        AppShell (eager)
├─ index                 → <Navigate to={`/meetings/${첫 회의}`} replace/>
├─ meetings/:meetingId   → MeetingView   (?u=<utteranceId>)
├─ lenses/:kind          → LensView      (kind: action|decision|promise)
├─ speakers              → SpeakersView
├─ settings              → SettingsView
└─ *                     → NotFoundView  (레일 유지, 중앙만 404)

/showcase                ShowcasePage — 레이아웃 밖, 현행 유지
```

`AppShell`은 eager다. 랜딩이 사라진 이상 "첫 화면 번들을 작게" 유지할 이유가
없고, LeftNav와 회의 목록 조회는 어차피 모든 화면에서 필요하다. 나머지 뷰는
`lazyRoute()`를 유지한다.

**`lazyRoute` fallback 수정 필요.** 현재 fallback은
`flex min-h-screen items-center justify-center`(`router.tsx:13`)인데, 그리드
직계 자식이 되면 col 1 / row 1에 놓여 LeftNav와 겹친다. `col-start-2 h-full`로
바꾼다.

### 인덱스 라우트

`useMeetings()` 결과의 **첫 항목**으로 `replace` 리다이렉트한다. 정렬은
서버가 주는 순서를 그대로 따르며(현재 레일 표기는 "최신순"), 이 설계에서
정렬 기준을 새로 정하지 않는다. `replace`이므로
뒤로가기 루프는 생기지 않는다. 로딩 중에는 기존 "회의를 불러오는 중…"
스피너를, 회의가 0건이면 리다이렉트 대상이 없으므로 `/`에 머무르며 기존
"아직 회의가 없어요" 빈 상태를 렌더한다. 두 상태 모두
`pages/meeting.tsx`의 `renderCenter()`에 이미 있는 마크업을 옮겨 쓴다.

### 잘못된 `:meetingId`

없는 회의 id로 들어오면 상세 조회가 404를 반환한다. 이때는 현재의 회의 상세
에러 상태("회의를 불러오지 못했어요" + 다시 시도)를 그대로 쓴다. 목록 레일은
살아 있으므로 사용자가 다른 회의를 고를 수 있다.

## 컴포넌트 구성

### `src/app/app-shell.tsx` (신규)

레이아웃 라우트 엘리먼트. 그리드 컨테이너 + `LeftNav` + `<Outlet/>` +
`CommandBar`를 렌더하고, ⌘K 키다운 리스너를 소유한다.

소유 state: `filter`(회의 목록 필터), `cmdOpen`, `cmdQuery`, `facets`.
⌘K 검색 결과 선택 시 `navigate()`로 이동한다.

### `src/pages/meeting.tsx` → `MeetingView`

`useParams().meetingId`와 `useSearchParams().get("u")`를 읽어 전사·인사이트·
오디오·플레이어만 담당한다. 반환값은 Fragment:

```jsx
<>
  <div className="col-start-2 flex min-w-0 flex-col">
    {처리 배너}
    {전사 + 인사이트}
  </div>
  {totalSeconds > 0 ? <PlayerBar className="col-span-2" … /> : null}
  <audio … />
</>
```

라우터에서 `key={meetingId}`로 마운트해 회의가 바뀔 때 리마운트되게 한다.

### `src/pages/lens.tsx` (신규)

`useParams().kind`를 검증해 `LensDashboard`에 넘기는 얇은 래퍼. 렌즈 전환은
`/lenses/:kind`로, 근거 점프는 `/meetings/:mid?u=:uid`로 `navigate`한다.
알 수 없는 `kind`면 `action`으로 `replace` 정규화한다.

### `SpeakersView` / `SettingsView`

내용은 그대로 두고 셸 안에 맞춘다.

- "회의로 돌아가기" 버튼과 **두 파일에 각각 중복 정의된** `BackIcon` 제거
  (`pages/speakers.tsx:11-25`, `pages/settings.tsx:9-23`)
- 루트 요소 `min-h-screen` → `col-start-2 h-full overflow-y-auto`
  (`max-w-2xl` 중앙 정렬은 유지)

### `NotFoundView`

"홈으로" 링크 제거 — 셸 안이라 레일이 그 역할을 한다. `col-start-2` 적용.

### `LeftNav`

props 네 개(`currentId`, `view`, `onSelectMeeting`, `onSelectLens`)를 잃는다.
활성 표시는 `useParams`/`useMatch`로 직접 판단하고, 회의 항목과 "모든 회의"는
`<Link>`가 된다. `filter`/`onFilter`/`onOpenSearch`만 `AppShell`에서 계속
받는다.

폭 클래스 `w-[var(--rail-nav)] shrink-0`은 유지한다. 그리드 트랙과 클래스가
같은 변수를 참조하므로 어긋날 수 없다.

## 상태 이전

| 현재 (`MeetingPage` state) | 이후 |
|---|---|
| `selectedId` | `useParams().meetingId` |
| `view` (`meeting`/`lens`) | 라우트 매칭 |
| `lens` | `useParams().kind` |
| `activeId` | `useSearchParams().get("u")` |
| `pendingSeek` | **제거** |
| `pos`·`playing`·`audioDuration` 수동 리셋 | **제거** |
| `tab`, `aiAck` | `MeetingView` state 유지 |
| `filter`, `cmdOpen`, `cmdQuery`, `facets` | `AppShell`로 이동 |

아래 두 줄이 이 작업의 실제 이득이다.

**`key={meetingId}` 리마운트가 수동 초기화를 대체한다.** `openMeeting`이 손으로
되돌리던 다섯 개 상태(`meeting.tsx:272-281`)와 `handleDeleted`의 같은
초기화(`meeting.tsx:333-343`)가 전부 불필요해진다.

**`pendingSeek`이 사라진다.** 이 state는 "다른 회의로 점프할 때 대상 오디오
로드를 기다려야 한다"는 문제(`meeting.tsx:283-297`, `546-557`)를 풀려고
있었다. 리마운트 후에는 "`onLoadedMetadata` 시점에 `u` 파라미터가 있으면
seek"으로 단일화되어 같은 회의/다른 회의 분기 자체가 없어진다.

`openMeeting`·`jumpTo`·`jumpToEvidence`·`handleDeleted`는 각각 `navigate()`
호출로 접힌다. 삭제 후에는 `navigate("/", { replace: true })`로 인덱스에
다시 위임한다.

**유지되는 것:** 재처리로 발언이 사라졌을 때의 historical 가드
(`meeting.tsx:319-331`)는 그대로 필요하다. `activeId`가 `?u=` 로 바뀌는 만큼
"찾을 수 없으면 토스트 + 비우기"는 `setSearchParams`로 `u`를 제거하는 형태가
된다.

## URL 계약

| URL | 의미 |
|-----|------|
| `/` | 목록 첫 회의로 리다이렉트 (회의 0건이면 빈 상태) |
| `/meetings/m_123` | 해당 회의의 전사 + 인사이트 |
| `/meetings/m_123?u=u_456` | 위 + `u_456` 발언 하이라이트·스크롤 |
| `/lenses/action` | 전역 렌즈 대시보드 (할 일) |
| `/speakers` | 화자 관리 |
| `/settings` | 처리 설정 |

## 동작 변경

1. **렌즈 대시보드로 전환하면 재생이 멈춘다.** 현재 `<audio>`는 `view`와
   무관하게 마운트돼 있어(`meeting.tsx:533`) 대시보드로 넘어가도 소리는 계속
   나고 `PlayerBar`만 사라진다 — 정지시킬 컨트롤이 없는 상태다. 개편 후에는
   회의 뷰를 벗어나면 오디오가 언마운트되어 멈춘다. 의도된 수정이다.
2. **화자·설정이 셸 안에서 열린다.** 회의 목록 레일이 유지되고 "회의로
   돌아가기" 버튼이 사라진다.
3. **404가 셸 안에서 렌더된다.** 레일로 곧장 복귀할 수 있다.
4. **회의 전환이 히스토리에 쌓인다.** 뒤로가기로 이전 회의로 돌아간다.

## 삭제 대상

- `src/pages/home.tsx`, `src/pages/home.test.tsx`
- `pages/speakers.tsx`·`pages/settings.tsx`의 `BackIcon` 및 뒤로가기 버튼
- `pages/not-found.tsx`의 "홈으로" 링크
- `router.tsx`의 "landing bundle" 주석 — 랜딩이 없어지므로 서술을 갱신한다

## 테스트 영향

- `pages/home.test.tsx` — 삭제.
- `pages/meeting.test.tsx`(889줄) — 라우터 결합은 `renderShell()` 헬퍼 한
  곳(553행)에만 있다. `MemoryRouter initialEntries={["/meetings/m1"]}` +
  `<Routes>` 형태로 바꾸면 개별 테스트 20여 개의 본문은 그대로다. 801행의
  render는 별도 `Harness`를 쓰므로 영향 없다.
- `pages/speakers.test.tsx`·`pages/settings.test.tsx` — 뒤로가기 링크에 대한
  단언이 없어 무변경. 이미 `MemoryRouter`로 감싸져 있다.

**추가할 테스트**

- 인덱스 라우트가 최신 회의로 리다이렉트한다.
- 회의가 0건이면 리다이렉트하지 않고 빈 상태를 렌더한다.
- `?u=` 가 붙은 주소로 진입하면 해당 발언이 하이라이트된다.
- 렌즈 대시보드에서 근거를 누르면 `/meetings/:id?u=:uid`로 이동한다.
- 없는 `:meetingId`로 진입하면 상세 에러 상태를 렌더하고 레일은 살아 있다.

## 문서 갱신

- `CLAUDE.md` 아키텍처 절의 라우터 서술(`/` eager, `/app` 셸)을 새 트리로
  교체한다. `/app`을 가리키는 다른 문장들도 함께 정정한다.
- `DESIGN.md` 5장은 `/app`을 3분할 셸로 지칭한다 — 경로 표기를 `/`로 고친다.
  레이아웃 다이어그램 자체는 유효하다.
