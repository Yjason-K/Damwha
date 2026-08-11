# 라우팅 구조 개편 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 루트 랜딩을 없애고 셸 레이아웃 라우트로 전환해, 회의 선택과 발언 하이라이트가 URL에 남고 화자·설정이 셸 안에서 열리게 한다.

**Architecture:** `AppShell` 레이아웃 라우트가 CSS Grid(2열 2행) 컨테이너 + `LeftNav` + `<Outlet/>` + ⌘K 팔레트를 소유한다. `<Outlet/>`은 래퍼 DOM 없이 라우트 엘리먼트를 렌더하므로, 회의 뷰가 Fragment로 반환한 본문(col 2 / row 1)과 `PlayerBar`(col-span-2 / row 2)가 각각 그리드 셀을 차지한다. 회의 선택은 `/meetings/:meetingId`, 발언 하이라이트+seek은 `?u=`로 표현한다.

**Tech Stack:** React 19, react-router v7 (`createBrowserRouter`), TanStack Query v5, Tailwind v4 (CSS-first, `tailwind.config` 없음), Vitest + Testing Library (jsdom).

설계 근거: [`docs/superpowers/specs/2026-08-11-routing-restructure-design.md`](../specs/2026-08-11-routing-restructure-design.md)

## Global Constraints

- **Node 22 + pnpm 필수** (`engine-strict=true`). 셸이 Node 20이면 명령마다 `nvm use 22 && pnpm ...`로 실행한다.
- **TypeScript strict + `verbatimModuleSyntax`** — 타입 전용 import는 반드시 `import type { ... }`.
- `noUnusedLocals` / `noUnusedParameters` 활성 — 안 쓰는 import·변수를 남기면 `tsc -b`가 실패한다.
- **Prettier:** 큰따옴표, 세미콜론, trailing comma `all`, printWidth 80. 작업 종료 전 `pnpm format`.
- **UI 문구·커밋 메시지·문서는 한국어.**
- **원시 hex 금지.** `src/index.css`의 시맨틱 별칭(`--surface-*`, `--text-*`, `--border-*`)을 참조한다. 레일 폭은 `var(--rail-nav)` / `var(--rail-insight)`로만.
- **타입 체크는 `pnpm build`의 `tsc -b`가 진실원이다.** Vite는 타입을 검사하지 않는다.
- 새 `<name>Variants` CVA export를 만들면 `eslint.config.js`의 `react-refresh/only-export-components` → `allowExportNames`에 등록해야 한다. (이 계획에는 해당 없음)
- 데스크톱 전용. 요청받지 않은 `md:` 등 breakpoint를 새로 뿌리지 않는다.

---

## File Structure

**신규**

| 파일 | 책임 |
|------|------|
| `src/app/app-shell.tsx` | 그리드 컨테이너, `LeftNav`, `<Outlet/>`, ⌘K 커맨드 팔레트. 셸 전역 state(`filter`, `cmdOpen`, `cmdQuery`, `facets`) 소유 |
| `src/pages/index-route.tsx` | `/` — 목록 로딩/오류/0건 상태, 그 외에는 첫 회의로 리다이렉트 |
| `src/pages/lens.tsx` | `/lenses/:kind` — kind 검증·정규화 후 `LensDashboard`에 위임 |
| `src/features/meeting/ui/center-state.tsx` | `CenterState` + `Spinner` — 중앙 칸 상태 표시의 공용 껍데기 |
| `src/pages/index-route.test.tsx` | 인덱스 라우트 3상태 + 리다이렉트 |
| `src/pages/lens.test.tsx` | kind 정규화 |

**수정**

| 파일 | 변경 |
|------|------|
| `src/app/router.tsx` | 평면 6라우트 → `AppShell` 아래 중첩. `routes` 배열을 별도 export(테스트에서 `createMemoryRouter`로 재사용) |
| `src/pages/meeting.tsx` | 604줄 → `MeetingRoute`(안정 부모) + `MeetingView`(회의별 리마운트). 셸 책임 제거 |
| `src/features/meeting/ui/left-nav.tsx` | props 4개 제거, `useParams`/`useMatch`/`Link`/`useNavigate` 사용 |
| `src/features/meeting/ui/player-bar.tsx` | `className` prop 추가 |
| `src/pages/speakers.tsx`, `src/pages/settings.tsx` | 뒤로가기 버튼·`BackIcon` 제거, 그리드 셀에 맞춤 |
| `src/pages/not-found.tsx` | "홈으로" 링크 제거, 그리드 셀에 맞춤 |
| `src/pages/meeting.test.tsx` | `renderShell()` 헬퍼를 실제 라우트 트리 기반으로 교체, 근거 점프 seek 테스트 반전 |
| `CLAUDE.md`, `DESIGN.md` | 라우터·경로 서술 갱신 |

**삭제**

- `src/pages/home.tsx`, `src/pages/home.test.tsx`

---

### Task 1: `PlayerBar`에 `className` prop 추가

`PlayerBarProps`에 `className`이 없어서 Task 4의 `col-span-2` 배치가 타입 오류가 난다. 먼저 열어둔다.

**Files:**
- Modify: `src/features/meeting/ui/player-bar.tsx:77-87` (타입), `110` (루트 div)
- Test: `src/features/meeting/ui/player-bar.test.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: `PlayerBarProps`에 `className?: string`. 루트 `<div>`의 기존 클래스와 `cn()`으로 병합된다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/features/meeting/ui/player-bar.test.tsx` 맨 아래에 추가한다. 파일 상단 import는 그대로 두고, `TRACKS` 상수를 재사용한다.

```tsx
test("className이 루트에 병합되고 기존 클래스도 유지된다", () => {
  const { container } = render(
    <PlayerBar
      tracks={TRACKS}
      playing={false}
      pos={0}
      totalSeconds={600}
      durLabel="10:00"
      speed={1}
      onSpeed={() => {}}
      onToggle={() => {}}
      onSeek={() => {}}
      className="col-span-2"
    />,
  );
  const root = container.firstElementChild!;
  expect(root).toHaveClass("col-span-2");
  expect(root).toHaveClass("border-t");
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
nvm use 22 && pnpm vitest run src/features/meeting/ui/player-bar.test.tsx
```

기대: `className`이 `PlayerBarProps`에 없어 타입 오류 + 런타임에서 `col-span-2` 클래스 없음으로 FAIL.

- [ ] **Step 3: 구현한다**

`src/features/meeting/ui/player-bar.tsx` 상단 import에 `cn`을 추가한다(이미 있으면 생략).

```tsx
import { cn } from "@/shared/lib/utils";
```

타입에 필드를 추가한다.

```tsx
type PlayerBarProps = {
  tracks: SpeakerLane[];
  playing: boolean;
  pos: number;
  totalSeconds: number;
  durLabel: string;
  speed: number;
  onSpeed: (speed: number) => void;
  onToggle: () => void;
  onSeek: (fraction: number) => void;
  className?: string;
};
```

구조 분해에 `className`을 추가하고 루트 div에 병합한다.

```tsx
export function PlayerBar({
  tracks,
  playing,
  pos,
  totalSeconds,
  durLabel,
  speed,
  onSpeed,
  onToggle,
  onSeek,
  className,
}: PlayerBarProps) {
```

```tsx
    <div
      className={cn(
        "flex shrink-0 items-center border-t border-border bg-[var(--surface-card)] px-5 pt-2.5 pb-3",
        className,
      )}
    >
```

- [ ] **Step 4: 통과를 확인한다**

```bash
nvm use 22 && pnpm vitest run src/features/meeting/ui/player-bar.test.tsx
```

기대: PASS (기존 드래그 테스트 포함 전부).

- [ ] **Step 5: 커밋**

```bash
git add src/features/meeting/ui/player-bar.tsx src/features/meeting/ui/player-bar.test.tsx
git commit -m "feat: PlayerBar에 className prop 추가"
```

---

### Task 2: `CenterState` 공용 추출 + `IndexRoute`

중앙 칸 상태 껍데기를 `meeting.tsx`에서 꺼내 공용 모듈로 만들고, 그 위에 인덱스 라우트를 세운다. 이 시점에는 아직 라우터를 건드리지 않으므로 앱 동작은 그대로다.

**Files:**
- Create: `src/features/meeting/ui/center-state.tsx`
- Create: `src/pages/index-route.tsx`
- Create: `src/pages/index-route.test.tsx`
- Modify: `src/pages/meeting.tsx:84-109` (`CenterState`/`Spinner` 정의를 삭제하고 import로 대체)

**Interfaces:**
- Consumes: Task 1의 변경 없음
- Produces:
  - `CenterState({ busy?: boolean, className?: string, children: React.ReactNode }): JSX.Element`
  - `Spinner(): JSX.Element`
  - `IndexRoute(): JSX.Element` — `/`의 라우트 엘리먼트

- [ ] **Step 1: `center-state.tsx`를 만든다**

`src/pages/meeting.tsx:84-109`의 두 컴포넌트를 그대로 옮기고 `className`만 추가한다.

```tsx
import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * 중앙 칸의 상태 표시 껍데기 — 로딩·오류·빈 상태에 공통으로 쓴다.
 * 그리드 셀에 직접 놓일 때는 className으로 배치를 넘긴다.
 */
export function CenterState({
  busy,
  className,
  children,
}: {
  busy?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={busy ? "status" : undefined}
      aria-busy={busy || undefined}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--surface-card)] px-8 text-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-6 shrink-0 animate-spin rounded-full border-2 border-[color:var(--accent-solid)] border-r-transparent"
    />
  );
}
```

- [ ] **Step 2: `meeting.tsx`가 새 모듈을 쓰게 한다**

`src/pages/meeting.tsx`에서 `CenterState`와 `Spinner` **정의**(84-109행)를 삭제하고 import를 추가한다.

```tsx
import { CenterState, Spinner } from "@/features/meeting/ui/center-state";
```

- [ ] **Step 3: 기존 테스트가 그대로 통과하는지 확인한다**

```bash
nvm use 22 && pnpm vitest run src/pages/meeting.test.tsx
```

기대: PASS. 순수 이동이라 동작 변화가 없어야 한다.

- [ ] **Step 4: `IndexRoute`의 실패하는 테스트를 작성한다**

`src/pages/index-route.test.tsx`를 만든다. `apiClient`를 목으로 두고 `GET /meetings` 응답만 바꿔가며 네 갈래를 검증한다.

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const { apiClient } = await import("@/shared/api/client");
const { IndexRoute } = await import("@/pages/index-route");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// WireMeeting 전체 필드 (src/features/meeting/api/types.ts:27-41).
const WIRE = [
  {
    id: "m1",
    title: "기획회의",
    original_filename: null,
    audio_key: "meetings/m1/original.m4a",
    normalized_key: null,
    recorded_at: null,
    duration_ms: 60_000,
    status: "done",
    is_favorite: false,
    current_job_id: null,
    processing_version: 1,
    error: null,
    created_at: "2026-08-10T00:00:00.000Z",
  },
];

function renderIndex() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<IndexRoute />} />
          <Route path="/meetings/:meetingId" element={<div>회의 상세</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("회의가 있으면 첫 회의로 리다이렉트한다", async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: WIRE } as never);
  renderIndex();
  expect(await screen.findByText(/회의 상세/)).toBeInTheDocument();
});

test("목록이 비어 있으면 리다이렉트하지 않고 빈 상태를 렌더한다", async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: [] } as never);
  renderIndex();
  expect(await screen.findByText("아직 회의가 없어요")).toBeInTheDocument();
  expect(screen.queryByText(/회의 상세/)).not.toBeInTheDocument();
});

test("목록 조회가 실패하면 오류 상태와 재시도 버튼을 렌더한다", async () => {
  vi.mocked(apiClient.get).mockRejectedValue(new Error("boom"));
  renderIndex();
  expect(
    await screen.findByText("회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
});
```

- [ ] **Step 5: 실패를 확인한다**

```bash
nvm use 22 && pnpm vitest run src/pages/index-route.test.tsx
```

기대: FAIL — `@/pages/index-route` 모듈이 없다.

- [ ] **Step 6: `IndexRoute`를 구현한다**

`src/pages/index-route.tsx`를 만든다. 세 상태의 문구·아이콘은 `meeting.tsx`의 `renderCenter()`(386-425행)에 있던 것을 그대로 쓴다. 목록 오류에는 원래 없던 재시도 버튼을 붙인다 — 인덱스에서는 이게 유일한 복구 수단이다.

```tsx
import { Navigate } from "react-router";

import { Button } from "@/shared/ui/button";
import { useMeetings } from "@/features/meeting/api/meetings";
import { CenterState, Spinner } from "@/features/meeting/ui/center-state";
import { Icon } from "@/features/meeting/ui/icons";

/**
 * `/` — 목록의 첫 회의(BE가 created_at DESC로 반환하므로 최신)로 replace
 * 리다이렉트한다. 리다이렉트할 대상이 없는 세 경우만 중앙 칸에 상태를 그린다.
 */
export function IndexRoute() {
  const { data: meetings, isLoading, isError, refetch } = useMeetings();

  if (isLoading) {
    return (
      <CenterState busy className="col-start-2">
        <Spinner />
        <p className="text-sm text-[color:var(--text-muted)]">
          회의를 불러오는 중…
        </p>
      </CenterState>
    );
  }

  if (isError) {
    return (
      <CenterState className="col-start-2">
        <Icon name="inbox" size={22} className="text-[color:var(--text-faint)]" />
        <p className="text-sm text-[color:var(--text-muted)]">
          회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
        <Button variant="secondary" size="sm" onClick={() => refetch()}>
          다시 시도
        </Button>
      </CenterState>
    );
  }

  const first = (meetings ?? [])[0];
  if (!first) {
    return (
      <CenterState className="col-start-2">
        <Icon name="mic" size={24} className="text-[color:var(--text-faint)]" />
        <p className="text-base font-semibold text-foreground">
          아직 회의가 없어요
        </p>
        <p className="text-sm text-[color:var(--text-muted)]">
          왼쪽의 “새 회의 기록하기”로 첫 회의를 만들어 보세요.
        </p>
      </CenterState>
    );
  }

  return <Navigate to={`/meetings/${first.id}`} replace />;
}
```

- [ ] **Step 7: 통과를 확인한다**

```bash
nvm use 22 && pnpm vitest run src/pages/index-route.test.tsx src/pages/meeting.test.tsx
```

기대: 둘 다 PASS.

- [ ] **Step 8: 커밋**

```bash
git add src/features/meeting/ui/center-state.tsx src/pages/index-route.tsx src/pages/index-route.test.tsx src/pages/meeting.tsx
git commit -m "feat: 중앙 상태 껍데기 추출과 인덱스 라우트 추가"
```

---

### Task 3: `LensView` — `/lenses/:kind`

`LensDashboard`는 이미 있고 `kind`를 상위에서 받는다. URL에서 읽어 검증·정규화하는 얇은 래퍼만 만든다.

**Files:**
- Create: `src/pages/lens.tsx`
- Create: `src/pages/lens.test.tsx`

**Interfaces:**
- Consumes: `LensDashboard({ lens: LensKind, onLens: (k: LensKind) => void, onJumpEvidence: (meetingId: string, utteranceId: string) => void })` (`src/features/lens/ui/lens-dashboard.tsx:18-24`), `LENS_META` (`src/features/lens/model/meta.ts`)
- Produces: `LensView(): JSX.Element` — `/lenses/:kind`의 라우트 엘리먼트

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`LensDashboard`는 자체 조회를 여럿 돌리므로 목으로 대체하고, 이 래퍼의 책임(정규화·navigate 배선)만 검증한다.

`src/pages/lens.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/features/lens/ui/lens-dashboard", () => ({
  LensDashboard: ({
    lens,
    onLens,
    onJumpEvidence,
  }: {
    lens: string;
    onLens: (k: string) => void;
    onJumpEvidence: (m: string, u: string) => void;
  }) => (
    <div>
      <span>렌즈: {lens}</span>
      <button type="button" onClick={() => onLens("decision")}>
        결정으로
      </button>
      <button type="button" onClick={() => onJumpEvidence("m2", "v3")}>
        근거로
      </button>
    </div>
  ),
}));

const { LensView } = await import("@/pages/lens");

afterEach(cleanup);

function Probe() {
  const loc = useLocation();
  return <span>경로: {loc.pathname + loc.search}</span>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="/lenses/:kind" element={<LensView />} />
        <Route path="/meetings/:meetingId" element={<div>회의 상세</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

test("유효한 kind는 그대로 대시보드에 전달된다", () => {
  renderAt("/lenses/promise");
  expect(screen.getByText("렌즈: promise")).toBeInTheDocument();
});

test("알 수 없는 kind는 action으로 정규화된다", () => {
  renderAt("/lenses/nope");
  expect(screen.getByText("렌즈: action")).toBeInTheDocument();
  expect(screen.getByText("경로: /lenses/action")).toBeInTheDocument();
});

test("렌즈 전환은 경로 이동이다", () => {
  renderAt("/lenses/action");
  fireEvent.click(screen.getByRole("button", { name: "결정으로" }));
  expect(screen.getByText("경로: /lenses/decision")).toBeInTheDocument();
});

test("근거 점프는 회의 경로에 u 쿼리를 붙여 이동한다", () => {
  renderAt("/lenses/action");
  fireEvent.click(screen.getByRole("button", { name: "근거로" }));
  expect(screen.getByText("경로: /meetings/m2?u=v3")).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
nvm use 22 && pnpm vitest run src/pages/lens.test.tsx
```

기대: FAIL — `@/pages/lens` 모듈이 없다.

- [ ] **Step 3: `LensView`를 구현한다**

`src/pages/lens.tsx`:

```tsx
import { Navigate, useNavigate, useParams } from "react-router";

import { LENS_META } from "@/features/lens/model/meta";
import type { LensKind } from "@/features/lens/model/types";
import { LensDashboard } from "@/features/lens/ui/lens-dashboard";

function isLensKind(v: string | undefined): v is LensKind {
  return !!v && v in LENS_META;
}

/** `/lenses/:kind` — 전역 렌즈 대시보드. 알 수 없는 kind는 action으로 정규화. */
export function LensView() {
  const { kind } = useParams();
  const navigate = useNavigate();

  if (!isLensKind(kind)) return <Navigate to="/lenses/action" replace />;

  return (
    <LensDashboard
      lens={kind}
      onLens={(k) => navigate(`/lenses/${k}`)}
      onJumpEvidence={(meetingId, utteranceId) =>
        navigate(`/meetings/${meetingId}?u=${utteranceId}`)
      }
    />
  );
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
nvm use 22 && pnpm vitest run src/pages/lens.test.tsx
```

기대: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/pages/lens.tsx src/pages/lens.test.tsx
git commit -m "feat: 전역 렌즈 대시보드 라우트 추가"
```

---

### Task 4: `AppShell` + 라우터 교체 + `MeetingView` 분리 + `LeftNav` 라우트화

핵심 작업이다. 셸 책임을 `MeetingPage`에서 `AppShell`로 옮기고, 라우터를 중첩 트리로 바꾸고, `LeftNav`를 자립시킨다. 이 셋은 서로 맞물려 있어 나눠서 커밋할 수 없다.

**끝난 뒤 남는 알려진 어색함:** `/speakers`·`/settings`·`*`가 아직 `min-h-screen`이라 그리드 셀 안에서 높이가 어긋나 보인다. Task 5에서 정리한다.

**Files:**
- Create: `src/app/app-shell.tsx`
- Modify: `src/app/router.tsx` (전면 재작성)
- Modify: `src/pages/meeting.tsx` (전면 재구성)
- Modify: `src/features/meeting/ui/left-nav.tsx`
- Modify: `src/pages/meeting.test.tsx` (`renderShell()` 헬퍼 + 근거 점프 테스트)
- Delete: `src/pages/home.tsx`, `src/pages/home.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `PlayerBar` `className`, Task 2의 `CenterState`/`Spinner`·`IndexRoute`, Task 3의 `LensView`
- Produces:
  - `AppShell(): JSX.Element` — 레이아웃 라우트 엘리먼트
  - `routes: RouteObject[]` — `src/app/router.tsx`에서 export. 테스트가 `createMemoryRouter(routes, { initialEntries })`로 재사용한다
  - `router` — `createBrowserRouter(routes)`
  - `MeetingRoute(): JSX.Element` — `/meetings/:meetingId`의 라우트 엘리먼트
  - `LeftNav({ filter, onFilter, onOpenSearch })` — props 3개로 축소

- [ ] **Step 1: `AppShell`을 만든다**

`src/pages/meeting.tsx`에서 ⌘K 관련 코드(`INITIAL_FACETS`, `highlight()`, `cmdOpen`/`cmdQuery`/`facets` state, 키다운 effect, `cmdGroups` 조립, `<CommandBar/>`)와 `filter` state, `<LeftNav/>`를 그대로 가져온다.

`src/app/app-shell.tsx`:

```tsx
import * as React from "react";
import { Outlet, useNavigate } from "react-router";

import {
  CommandBar,
  type CommandGroup,
  type CommandItem,
} from "@/shared/ui/command-bar";
import { Tag } from "@/shared/ui/tag";

import { formatClock } from "@/features/meeting/api/mappers";
import { useMeetings } from "@/features/meeting/api/meetings";
import { useSearch } from "@/features/meeting/api/search";
import type { MeetingFilter } from "@/features/meeting/model/types";
import { Icon } from "@/features/meeting/ui/icons";
import { LeftNav } from "@/features/meeting/ui/left-nav";

/**
 * AppShell — 모든 제품 화면의 레이아웃 라우트. 2열 2행 그리드로,
 * col 1/row 1은 LeftNav, col 2/row 1은 <Outlet/>이 채운다. row 2는 회의 뷰가
 * PlayerBar를 col-span-2로 놓을 때만 높이를 갖는다(그 외에는 0으로 접힘).
 * CommandBar는 Radix Dialog Portal이라 그리드 항목이 되지 않는다.
 */

type Facet = { id: string; label: string; speaker?: number };

const INITIAL_FACETS: Facet[] = [
  { id: "f1", label: "김영재", speaker: 1 },
  { id: "f2", label: "지난주" },
  { id: "f3", label: "기획회의" },
];

/** Clip around the first match and wrap it in a highlighted <mark>. */
function highlight(text: string, q: string): React.ReactNode {
  const clip = (s: string) => (s.length > 52 ? `${s.slice(0, 52)}…` : s);
  if (!q) return clip(text);
  const i = text.indexOf(q);
  if (i < 0) return clip(text);
  const start = Math.max(0, i - 16);
  const slice = (start ? "…" : "") + text.slice(start);
  const j = slice.indexOf(q);
  return (
    <>
      {slice.slice(0, j)}
      <mark className="rounded-[2px] bg-[var(--accent-2)] text-[color:var(--accent-text)]">
        {q}
      </mark>
      {slice.slice(j + q.length, j + q.length + 28)}…
    </>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const [filter, setFilter] = React.useState<MeetingFilter>("all");
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdQuery, setCmdQuery] = React.useState("");
  const [facets, setFacets] = React.useState<Facet[]>(INITIAL_FACETS);

  const { data: meetings } = useMeetings();
  const { data: hits = [] } = useSearch(cmdQuery);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = cmdQuery.trim();
  const utteranceItems: CommandItem[] = hits.slice(0, 6).map((h) => ({
    id: `u:${h.meetingId}:${h.utteranceId}`,
    icon: <Icon name="quote" size={15} />,
    title: highlight(h.text, q),
    meta: [h.meetingTitle ?? "제목 없는 회의", h.speakerName]
      .filter(Boolean)
      .join(" · "),
    trail: formatClock(h.startMs),
  }));

  // '회의' 그룹은 발화 히트가 가리키는 회의 + 제목이 질의에 매칭되는 회의를
  // 합친다(중복 제거). 제목만 매칭되는 회의(발화 히트 없음)도 노출된다.
  const meetingItems: CommandItem[] = [];
  const seenMeetings = new Set<string>();
  const pushMeeting = (id: string, title: string) => {
    if (seenMeetings.has(id)) return;
    seenMeetings.add(id);
    meetingItems.push({
      id: `m:${id}`,
      icon: <Icon name="file" size={15} />,
      title,
    });
  };
  for (const h of hits)
    pushMeeting(h.meetingId, h.meetingTitle ?? "제목 없는 회의");
  if (q) {
    for (const m of meetings ?? []) {
      if (m.title.includes(q)) pushMeeting(m.id, m.title);
    }
  }

  const cmdGroups: CommandGroup[] = [
    { label: "발언", items: utteranceItems },
    { label: "회의", items: meetingItems.slice(0, 5) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="grid h-screen min-w-[1160px] grid-cols-[var(--rail-nav)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] bg-[var(--surface-app)] text-foreground">
      <LeftNav
        filter={filter}
        onFilter={setFilter}
        onOpenSearch={() => setCmdOpen(true)}
      />
      <Outlet />

      <CommandBar
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        query={cmdQuery}
        onQueryChange={setCmdQuery}
        facets={
          facets.length > 0 ? (
            <>
              {facets.map((f) => (
                <Tag
                  key={f.id}
                  speaker={f.speaker}
                  onRemove={() =>
                    setFacets((fs) => fs.filter((x) => x.id !== f.id))
                  }
                >
                  {f.label}
                </Tag>
              ))}
            </>
          ) : undefined
        }
        groups={cmdGroups}
        onSelect={(item) => {
          if (!item.id) return;
          setCmdOpen(false);
          const [kind, mid, uid] = item.id.split(":");
          if (kind === "u") navigate(`/meetings/${mid}?u=${uid}`);
          else if (kind === "m") navigate(`/meetings/${mid}`);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: `LeftNav`를 라우트 기반으로 바꾼다**

`src/features/meeting/ui/left-nav.tsx`에서 props 타입과 시그니처를 줄인다.

```tsx
type LeftNavProps = {
  filter: MeetingFilter;
  onFilter: (f: MeetingFilter) => void;
  onOpenSearch: () => void;
};

export function LeftNav({ filter, onFilter, onOpenSearch }: LeftNavProps) {
  const navigate = useNavigate();
  const { meetingId } = useParams();
  const lensMatch = useMatch("/lenses/:kind");
  const speakersMatch = useMatch("/speakers");
  const settingsMatch = useMatch("/settings");
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const { data: meetings, isLoading, isError } = useMeetings();
  const filtered = (meetings ?? []).filter((m) =>
    filter === "fav" ? m.fav : true,
  );
```

import를 갱신한다(안 쓰는 `LensKind` 타입 import 제거 — `noUnusedLocals`가 잡는다).

```tsx
import { Link, useMatch, useNavigate, useParams } from "react-router";
```

```tsx
import type { MeetingFilter, MeetingStatus } from "../model/types";
```

내비 4개를 링크로 바꾼다. 화자·설정에도 활성 표시가 생긴다 — 셸 안으로 들어오면서 현재 위치 피드백이 필요해졌다.

```tsx
        <div className="mt-3.5 flex flex-col gap-0.5">
          <SidebarItem
            icon={<Icon name="bookmark" size={16} />}
            label="저장한 발언"
          />
          <SidebarItem
            icon={<Icon name="listChecks" size={16} />}
            label="모든 회의"
            active={!!lensMatch}
            asChild
          >
            <Link to="/lenses/action" />
          </SidebarItem>
          <SidebarItem
            icon={<Icon name="users" size={16} />}
            label="화자 관리"
            active={!!speakersMatch}
            asChild
          >
            <Link to="/speakers" />
          </SidebarItem>
          <SidebarItem
            icon={<Icon name="settings" size={16} />}
            label="처리 설정"
            active={!!settingsMatch}
            asChild
          >
            <Link to="/settings" />
          </SidebarItem>
        </div>
```

회의 목록 항목도 링크로 바꾼다. `SidebarItem`은 `asChild`여도 `label`/`sub`/`meta`/`active`를 유지한다(`sidebar-item.tsx:100-114`).

```tsx
            filtered.map((m) => (
              <li key={m.id}>
                <SidebarItem
                  label={m.title}
                  sub={m.sub}
                  meta={statusBadge(m.status) ?? m.dur}
                  active={meetingId === m.id}
                  asChild
                >
                  <Link to={`/meetings/${m.id}`} />
                </SidebarItem>
              </li>
            ))
```

업로드 완료 후 이동은 `LeftNav`가 직접 한다.

```tsx
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={(id) => navigate(`/meetings/${id}`)}
      />
```

- [ ] **Step 3: `meeting.tsx`를 `MeetingRoute` + `MeetingView`로 재구성한다**

셸 책임(⌘K·LeftNav·filter·view/lens state)을 모두 걷어내고 아래 구조로 만든다. `ProcessingBanner`·`STAGE_LABELS`는 그대로 둔다.

`aiAck`는 **`MeetingRoute`가 소유한다.** `MeetingView`는 `key`로 리마운트되므로 여기에 두면 회의를 오갈 때마다 AI 안내 배너가 되살아난다. `MeetingRoute`는 파라미터가 바뀌어도 리마운트되지 않는 안정된 부모라 Record를 유지할 수 있다.

```tsx
export function MeetingRoute() {
  const { meetingId = "" } = useParams();
  const [aiAck, setAiAck] = React.useState<Record<string, boolean>>({});

  return (
    <MeetingView
      key={meetingId}
      meetingId={meetingId}
      aiAcked={!!aiAck[meetingId]}
      onAckAi={() => setAiAck((a) => ({ ...a, [meetingId]: true }))}
    />
  );
}

type MeetingViewProps = {
  meetingId: string;
  aiAcked: boolean;
  onAckAi: () => void;
};

function MeetingView({ meetingId, aiAcked, onAckAi }: MeetingViewProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.get("u") ?? "";

  const [tab, setTab] = React.useState("summary");
  const [playing, setPlaying] = React.useState(false);
  const [pos, setPos] = React.useState(0);
  const [speed, setSpeed] = React.useState(1);
  const [audioDuration, setAudioDuration] = React.useState(0);
  const [metaReady, setMetaReady] = React.useState(false);

  const audioRef = React.useRef<HTMLAudioElement>(null);

  const {
    data: meeting,
    isError: meetingError,
    isFetching: meetingFetching,
    refetch: refetchMeeting,
  } = useMeeting(meetingId);

  // 아래 훅들은 기존 코드 그대로다 — 인자만 currentId → meetingId로 바꾼다.
  const { data: lensItems = [] } = useMeetingLenses(meetingId);
  const setLensCompletion = useSetLensCompletion();
  const generateSummary = useGenerateSummary();
  const meetingLenses = React.useMemo(
    () => (meeting ? mapMeetingLenses(lensItems, meeting.speakers) : {}),
    [lensItems, meeting],
  );

  const summaryPending =
    meeting?.summaryStatus === "queued" ||
    meeting?.summaryStatus === "running" ||
    generateSummary.isPending;

  const statusEnabled =
    !!meeting &&
    (meeting.status === "uploaded" ||
      meeting.status === "processing" ||
      summaryPending);
  const { data: procStatus } = useMeetingStatus(meetingId, statusEnabled);

  useSyncSummaryStatus(
    meetingId,
    meeting?.summaryStatus,
    procStatus?.summary_status,
  );

  const { toast } = useToast();
```

기존 코드에서 **삭제**할 것: `view`·`selectedId`·`lens`·`filter`·`activeId` state, `cmdOpen`/`cmdQuery`/`facets`, `INITIAL_FACETS`, `highlight()`, ⌘K effect, `pendingSeek`, `openMeeting`, `jumpTo`, `openLens`, `jumpToEvidence`, `handleDeleted`, `cmdGroups` 조립, `<LeftNav/>`, `<CommandBar/>`, `<LensDashboard/>` 분기, `renderCenter()`의 목록 상태 3분기(로딩/오류/0건 — `IndexRoute`로 갔다).

`renderCenter()`는 상세 오류·상세 로딩·본문 세 갈래만 남는다.

점프·삭제는 전부 이동으로 접힌다.

```tsx
  const jumpTo = (uid: string) => {
    setSearchParams({ u: uid });
  };

  const handleDeleted = () => {
    navigate("/", { replace: true });
  };
```

반환값은 Fragment다. 본문 래퍼가 col 2 / row 1, `PlayerBar`가 row 2 전체를 차지한다.

```tsx
  return (
    <>
      <div className="col-start-2 flex min-w-0 flex-col">
        {meeting && meeting.status !== "done" ? (
          <ProcessingBanner meeting={meeting} status={procStatus} />
        ) : null}
        <div className="flex min-h-0 flex-1">{renderCenter()}</div>
      </div>

      {meeting && totalSeconds > 0 ? (
        <PlayerBar
          className="col-span-2"
          tracks={meeting.tracks}
          playing={playing}
          pos={pos}
          totalSeconds={totalSeconds}
          durLabel={
            mappedTotal > 0 ? meeting.dur : formatClock(totalSeconds * 1000)
          }
          speed={speed}
          onSpeed={setSpeed}
          onToggle={() => setPlaying((p) => !p)}
          onSeek={seek}
        />
      ) : null}

      {meeting ? (
        <audio
          ref={audioRef}
          src={meeting.audioUrl}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setAudioDuration(d);
            setMetaReady(true);
          }}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            const total =
              Number.isFinite(a.duration) && a.duration > 0
                ? a.duration
                : totalSeconds;
            if (total > 0) setPos(Math.min(1, a.currentTime / total));
          }}
          onEnded={() => setPlaying(false)}
        />
      ) : null}
    </>
  );
```

`<audio>`의 `key={meeting.id}`와 `PlayerBar`의 `key={...}`는 뺀다 — `MeetingView` 자체가 회의별로 리마운트되므로 불필요하다.

- [ ] **Step 4: `?u=` seek effect를 넣는다**

`onLoadedMetadata`는 준비 여부만 기록하고, seek은 effect가 한다. 이미 열린 회의에서 `?u=`만 바뀌는 경로(검색·전사 클릭)를 놓치지 않기 위해서다.

**의존성은 `meeting` 객체가 아니라 파생한 숫자여야 한다.** `useMeeting`은 처리 중인 회의를 2.5초 간격으로 폴링하고 매번 새 객체를 돌려주므로, `meeting`을 의존성에 두면 사용자가 스크럽할 때마다 되돌려 놓는다.

```tsx
  const mappedTotal = meeting?.totalSeconds ?? 0;
  const totalSeconds = mappedTotal > 0 ? mappedTotal : audioDuration;

  // 하이라이트 대상 발언의 시작 시각. 폴링 재조회로 meeting 객체가 새로 와도
  // 값이 같으면 identity가 유지되어 아래 effect가 헛돌지 않는다.
  const targetStartMs = React.useMemo(() => {
    if (!activeId || !meeting) return null;
    const source = meeting.utterances
      .flatMap((x) => x.sources)
      .find((s) => s.id === activeId);
    return source ? source.startMs : null;
  }, [activeId, meeting]);

  React.useEffect(() => {
    if (targetStartMs == null || !metaReady || totalSeconds <= 0) return;
    const fraction = Math.min(1, targetStartMs / 1000 / totalSeconds);
    const a = audioRef.current;
    if (a) a.currentTime = fraction * totalSeconds;
    // 외부 신호(?u=)를 재생 위치에 반영하는 의도된 effect다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos(fraction);
  }, [targetStartMs, metaReady, totalSeconds]);
```

historical 가드는 `?u=` 제거로 바꾸되 **반드시 `replace: true`**를 준다. 히스토리에 남기면 뒤로가기로 무효한 `u`가 되살아나 토스트가 반복된다.

```tsx
  React.useEffect(() => {
    if (!activeId || !meeting || meetingFetching) return;
    const found = meeting.utterances.some(
      (u) => u.id === activeId || u.sources.some((s) => s.id === activeId),
    );
    if (!found) {
      toast({
        description: "재처리로 근거 발언을 현재 버전에서 찾을 수 없어요.",
      });
      setSearchParams({}, { replace: true });
    }
  }, [activeId, meeting, meetingFetching, toast, setSearchParams]);
```

- [ ] **Step 5: 라우터를 중첩 트리로 교체한다**

`src/app/router.tsx` 전면 재작성. `routes`를 따로 export해 테스트가 `createMemoryRouter`로 같은 트리를 쓰게 한다.

```tsx
import { createElement, lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";

import { AppShell } from "@/app/app-shell";
import { IndexRoute } from "@/pages/index-route";
import { NotFoundPage } from "@/pages/not-found";

// 셸(AppShell·LeftNav·인덱스)은 모든 화면에서 필요하므로 eager. 나머지 뷰는
// 각자 청크로 분리해 필요할 때 받는다. fallback은 그리드의 col 2에 놓인다.
function lazyRoute(loader: () => Promise<{ default: ComponentType }>) {
  return (
    <Suspense
      fallback={
        <div className="col-start-2 flex h-full items-center justify-center bg-background">
          <span
            role="status"
            aria-label="로딩 중"
            className="size-5 animate-spin rounded-full border-2 border-[color:var(--text-muted)] border-r-transparent"
          />
        </div>
      }
    >
      {createElement(lazy(loader))}
    </Suspense>
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <IndexRoute /> },
      {
        path: "meetings/:meetingId",
        element: lazyRoute(() =>
          import("@/pages/meeting").then((m) => ({ default: m.MeetingRoute })),
        ),
      },
      {
        path: "lenses/:kind",
        element: lazyRoute(() =>
          import("@/pages/lens").then((m) => ({ default: m.LensView })),
        ),
      },
      {
        path: "speakers",
        element: lazyRoute(() =>
          import("@/pages/speakers").then((m) => ({ default: m.SpeakersPage })),
        ),
      },
      {
        path: "settings",
        element: lazyRoute(() =>
          import("@/pages/settings").then((m) => ({ default: m.SettingsPage })),
        ),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
  {
    path: "/showcase",
    element: lazyRoute(() =>
      import("@/pages/showcase").then((m) => ({ default: m.ShowcasePage })),
    ),
  },
];

export const router = createBrowserRouter(routes);
```

- [ ] **Step 6: 홈 페이지를 지운다**

```bash
git rm src/pages/home.tsx src/pages/home.test.tsx
```

- [ ] **Step 7: `meeting.test.tsx`의 렌더 헬퍼를 실제 라우트 트리로 바꾼다**

553-568행의 `renderShell()`을 교체한다. import에 `createMemoryRouter`/`RouterProvider`를 추가하고 `MemoryRouter`는 이 파일에서 더 쓰지 않으면 제거한다.

```tsx
import { createMemoryRouter, RouterProvider } from "react-router";
import { routes } from "@/app/router";

function renderShell(initialEntry = "/meetings/m1") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
}
```

548행의 `const { MeetingPage } = await import("@/pages/meeting");`는 더 이상 필요 없다 — 라우터가 직접 로드한다. 삭제한다.

- [ ] **Step 8: 근거 점프 seek 테스트를 반전시킨다**

668행 테스트는 "근거 점프는 seek되지 않는다"를 단언한다. `?u=` 통일로 동작이 바뀌었으므로 제목·주석·단언을 뒤집는다.

```tsx
test("전역 렌즈 대시보드에서 근거 점프하면 회의뷰로 전환되고 발언 하이라이트와 seek이 함께 일어난다", async () => {
  const { container } = renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("link", { name: "모든 회의" }));
  await screen.findByRole("heading", { level: 1, name: "내 액션아이템" });

  const jumpCard = (
    await screen.findByText("다음 스프린트 자료 공유하기")
  ).closest(".rounded-sm") as HTMLElement;
  fireEvent.click(within(jumpCard).getByRole("button", { name: /원문 보기/ }));

  // m2("스프린트 회고")로 전환되고, v3를 포함하는 병합 블록(v2)이 하이라이트된다.
  expect(
    await screen.findByRole("heading", { level: 1, name: "스프린트 회고" }),
  ).toBeInTheDocument();
  const log = screen.getByRole("log", { name: "회의 전사" });
  expect(log.querySelector('[data-uid="v2"]')).toHaveClass(
    "bg-[var(--accent-1)]",
  );

  // ?u=는 하이라이트와 seek을 함께 뜻한다 — v3.start_ms = 12_000 → 12초.
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBeCloseTo(12, 3);
});
```

- [ ] **Step 9: 나머지 테스트의 회의 전환 조작을 링크로 고친다**

목록 항목과 "모든 회의"가 `<button>`에서 `<a>`로 바뀌었으므로, 해당 조회를 `getByRole("link", ...)`로 바꾼다. 대상을 먼저 뽑는다.

```bash
nvm use 22 && grep -n 'getByRole("button"' src/pages/meeting.test.tsx
```

바꿀 것은 **회의 목록 항목**(`/스프린트 회고/` 등 회의 제목으로 찾는 것)과 **"모든 회의"** 두 종류뿐이다. "새 회의 기록하기", 필터 pill(`전체`/`즐겨찾기`), 다이얼로그 안 버튼들은 여전히 `<button>`이므로 건드리지 않는다.

- [ ] **Step 10: 같은 회의 안에서 `?u=`만 바뀌어도 seek되는지 테스트한다**

이 계획에서 가장 중요한 회귀 테스트다. `onLoadedMetadata` 기반 구현이었다면 여기서 실패한다 — 같은 회의라 오디오가 재로드되지 않아 이벤트가 뜨지 않기 때문이다.

`src/pages/meeting.test.tsx`에 추가한다.

```tsx
test("이미 열린 회의에서 ?u=만 바뀌어도 재생 위치가 옮겨진다", async () => {
  const { container } = renderShell("/meetings/m2");
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });

  // 메타데이터를 먼저 준비시킨다 — 이 시점엔 아직 u가 없다.
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(0);

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const option = await screen.findByRole("option", {
    name: /다음 스프린트도 이어가죠/,
  });
  fireEvent.click(option);

  // 같은 회의라 오디오는 재로드되지 않는다. loadedMetadata를 다시 쏘지 않아도
  // seek되어야 한다 — v3.start_ms = 12_000 → 12초.
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(12, 3));
});
```

- [ ] **Step 11: 없는 회의 id 진입을 테스트한다**

목 헬퍼 `getResponse()`에 이미 `m_err`가 거절 응답으로 준비돼 있다(`meeting.test.tsx` 내 `if (m[1] === "m_err") return Promise.reject(...)`). 그대로 쓴다.

```tsx
test("없는 회의 id로 진입하면 상세 오류 상태를 렌더하고 레일은 살아 있다", async () => {
  renderShell("/meetings/m_err");
  expect(
    await screen.findByText(
      "회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("navigation", { name: "주 탐색" }),
  ).toBeInTheDocument();
});
```

- [ ] **Step 12: historical 가드가 `u`를 `replace`로 제거하는지 단언을 보강한다**

"근거 점프 대상 발언이 재처리로 사라졌으면 토스트를 띄우고 activeId를 비운다" 테스트(기존 ~700행)의 끝에 URL 단언을 덧붙인다. `renderShell()`이 반환하는 라우터로 현재 위치를 읽는다. 헬퍼가 라우터를 함께 돌려주도록 살짝 고친다.

```tsx
function renderShell(initialEntry = "/meetings/m1") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...utils, router };
}
```

기존 테스트 끝에 추가한다.

```tsx
  // u는 히스토리에 남지 않아야 한다 — 남으면 뒤로가기로 되살아나 토스트가 반복된다.
  await waitFor(() =>
    expect(router.state.location.search).toBe(""),
  );
```

- [ ] **Step 13: 업로드 완료 후 이동을 테스트한다**

`LeftNav`가 직접 이동하게 됐으므로 그 배선만 좁게 검증한다. `UploadDialog`를 목으로 대체해 업로드 자체는 흉내 내지 않는다.

`src/features/meeting/ui/left-nav.test.tsx`를 만든다.

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn() },
}));

vi.mock("@/features/meeting/ui/upload-dialog", () => ({
  UploadDialog: ({ onUploaded }: { onUploaded: (id: string) => void }) => (
    <button type="button" onClick={() => onUploaded("m9")}>
      업로드 완료 흉내
    </button>
  ),
}));

const { LeftNav } = await import("@/features/meeting/ui/left-nav");

afterEach(cleanup);

function Probe() {
  return <span>경로: {useLocation().pathname}</span>;
}

test("업로드가 끝나면 새 회의 경로로 이동한다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
        <Routes>
          <Route
            path="*"
            element={
              <LeftNav filter="all" onFilter={() => {}} onOpenSearch={() => {}} />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "업로드 완료 흉내" }));
  expect(await screen.findByText("경로: /meetings/m9")).toBeInTheDocument();
});
```

- [ ] **Step 14: 전체 테스트를 돌린다**

```bash
nvm use 22 && pnpm vitest run
```

기대: 전부 PASS. 실패가 남으면 조회 셀렉터(button→link)와 초기 경로를 먼저 의심한다.

- [ ] **Step 15: 타입과 린트를 확인한다**

```bash
nvm use 22 && pnpm build && pnpm lint
```

기대: 둘 다 성공. `noUnusedLocals`가 걷어내지 못한 import를 잡아줄 것이다.

- [ ] **Step 16: 커밋**

```bash
git add -A
git commit -m "feat: 셸 레이아웃 라우트로 전환하고 회의 선택을 URL로 올림

- AppShell이 그리드·LeftNav·⌘K를 소유하고 <Outlet/>으로 뷰를 받는다
- /meetings/:meetingId + ?u= 로 회의 선택과 발언 하이라이트를 표현
- ?u= seek을 준비 상태 effect로 판정해 같은 회의 내 변경도 반영
- LeftNav가 라우트를 직접 읽고 업로드 후 이동도 스스로 처리
- 루트 랜딩 제거"
```

---

### Task 5: 부속 페이지를 셸에 맞춘다

`/speakers`·`/settings`·404가 그리드 셀 안에서 제대로 자리잡게 한다.

**Files:**
- Modify: `src/pages/speakers.tsx:11-25` (`BackIcon`), `:130-140` 부근(뒤로가기 버튼), 루트 `<main>`
- Modify: `src/pages/settings.tsx:9-23` (`BackIcon`), `:33-38` (뒤로가기 버튼), 루트 `<main>`
- Modify: `src/pages/not-found.tsx`

**Interfaces:**
- Consumes: Task 4의 `AppShell` 그리드
- Produces: 없음 (표현 계층만)

- [ ] **Step 1: `settings.tsx`를 정리한다**

`BackIcon` 정의(9-23행)와 뒤로가기 버튼(33-38행)을 삭제하고, `Button`·`Link` import가 다른 데서 안 쓰이면 함께 지운다. 루트 요소를 그리드 셀에 맞춘다.

```tsx
    <main className="col-start-2 h-full overflow-y-auto bg-background text-foreground">
```

`<header>`는 이제 제목 블록만 남는다.

```tsx
        <header className="flex flex-col gap-1">
          <h1 className="text-display font-bold">처리 설정</h1>
          <p className="text-base text-[color:var(--text-muted)]">
            이 머신 성능에 맞춰 회의 처리 방식(모델·GPU)을 고를 수 있어요.
          </p>
        </header>
```

- [ ] **Step 2: `speakers.tsx`를 같은 방식으로 정리한다**

`BackIcon` 정의(11-25행)와 `<Link to="/app">`을 감싼 뒤로가기 버튼을 삭제한다. `PlusIcon`·`MicIcon`은 계속 쓰이므로 남긴다. 루트 요소를 그리드 셀에 맞춘다.

```tsx
    <main className="col-start-2 h-full overflow-y-auto bg-background text-foreground">
```

- [ ] **Step 3: `not-found.tsx`를 셸 안 404로 바꾼다**

레일이 복귀 수단이므로 "홈으로" 링크를 없앤다.

```tsx
export function NotFoundPage() {
  return (
    <main className="col-start-2 flex h-full flex-col items-center justify-center gap-2 bg-background text-foreground">
      <h1 className="text-3xl font-bold">404</h1>
      <p className="text-sm text-[color:var(--text-muted)]">
        찾을 수 없는 페이지예요. 왼쪽에서 회의를 골라 주세요.
      </p>
    </main>
  );
}
```

- [ ] **Step 4: 테스트를 돌린다**

```bash
nvm use 22 && pnpm vitest run src/pages/speakers.test.tsx src/pages/settings.test.tsx
```

기대: PASS. 두 파일 모두 뒤로가기 링크를 단언하지 않는다.

- [ ] **Step 5: 타입·린트·포맷을 확인한다**

```bash
nvm use 22 && pnpm build && pnpm lint && pnpm format
```

기대: 성공. 안 쓰게 된 `Button`/`Link` import가 남아 있으면 여기서 잡힌다.

- [ ] **Step 6: 브라우저에서 눈으로 확인한다**

```bash
nvm use 22 && pnpm dev
```

확인 항목:
1. `/`로 들어가면 최신 회의로 주소가 바뀐다.
2. 회의를 바꾸면 주소가 따라 바뀌고, 뒤로가기로 이전 회의로 돌아간다.
3. ⌘K로 발언을 고르면 `?u=`가 붙고 재생 위치가 그 지점으로 간다.
4. 같은 회의에서 다른 발언을 또 고르면 재생 위치가 다시 옮겨진다.
5. 화자 관리·처리 설정에서 왼쪽 레일이 그대로 있고 해당 항목이 활성 표시된다.
6. 렌즈 대시보드·화자·설정에서 하단 PlayerBar가 보이지 않는다.
7. 회의 화면에서 PlayerBar의 재생 버튼이 레일 폭 안에 정렬돼 있다.

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "feat: 화자·설정·404를 셸 레이아웃에 맞춤"
```

---

### Task 6: 문서 갱신

살아있는 문서가 새 구조를 가리키게 한다. `docs/superpowers/`의 스펙·계획은 날짜 스냅샷이므로 건드리지 않는다.

**Files:**
- Modify: `CLAUDE.md` (아키텍처 절의 라우터 서술, `/app` 언급, 82행 근거 점프 서술)
- Modify: `DESIGN.md:143` (`/app` 경로 표기)

**Interfaces:**
- Consumes: Task 4·5의 최종 구조
- Produces: 없음

- [ ] **Step 1: `CLAUDE.md`의 라우터 서술을 교체한다**

`src/app/` 항목의 `router.tsx` 설명을 새 트리로 바꾼다.

```markdown
  - `router.tsx` — `createBrowserRouter`. `AppShell`(`app/app-shell.tsx`)이
    레이아웃 라우트로 그리드·`LeftNav`·⌘K 팔레트를 소유하고, 그 아래
    `index`(최신 회의로 리다이렉트) / `meetings/:meetingId` / `lenses/:kind` /
    `speakers` / `settings` / `*`가 붙는다. 셸과 인덱스는 **eager**, 나머지는
    `lazyRoute()`로 코드 분할한다. `routes` 배열을 별도 export하므로 테스트가
    `createMemoryRouter(routes, { initialEntries })`로 같은 트리를 쓴다.
```

- [ ] **Step 2: `/app`을 가리키는 다른 문장들을 고친다**

```bash
grep -n "/app" CLAUDE.md DESIGN.md
```

찾은 곳을 전부 새 경로로 정정한다. 3분할 셸을 지칭하는 문장은 `/meetings/:meetingId`로, 셸 전반을 뜻하면 "셸"로 바꾼다. `DESIGN.md:143`의 "`/app`은 browse-first 3분할 셸이다"는 "셸은 browse-first 3분할이다"로 고친다 — 레이아웃 다이어그램 자체는 그대로 유효하다.

- [ ] **Step 3: 근거 점프 서술(`CLAUDE.md:82`)을 갱신한다**

```markdown
- **Evidence jump navigates to `/meetings/:id?u=<utteranceId>`** — the URL carries
  both the highlight and the audio seek, so search jumps and lens evidence jumps
  now behave identically (the earlier "no audio seek" carve-out is gone).
  Historical items whose utterance no longer exists after reprocess surface a
  toast and drop `?u=` with `replace: true`.
```

- [ ] **Step 4: URL 계약을 CLAUDE.md에 남긴다**

아키텍처 절 끝에 덧붙인다.

```markdown
**URL 계약:** `/` → 목록 첫 회의로 replace 리다이렉트 · `/meetings/:id` 회의 상세
· `/meetings/:id?u=<utteranceId>` 하이라이트 + 그 지점으로 seek ·
`/lenses/:kind` 전역 렌즈 · `/speakers` · `/settings`. 인사이트 탭과 회의 목록
필터는 의도적으로 URL에 담지 않는다.
```

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md DESIGN.md
git commit -m "docs: 라우팅 개편에 맞춰 살아있는 문서 갱신"
```

---

## 완료 기준

- `pnpm test` 전부 통과, `pnpm build`(= `tsc -b` + 번들) 성공, `pnpm lint` 무경고.
- Task 5 Step 6의 육안 확인 7항목 통과.
- `src/pages/home.tsx`와 `src/pages/home.test.tsx`가 없다.
- `grep -rn '"/app"' src`가 빈 결과다.
