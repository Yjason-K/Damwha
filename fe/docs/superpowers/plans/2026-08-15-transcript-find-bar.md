# 전사 찾기 바 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `TranscriptPane`의 죽은 UI(공유·더보기·저장·전체 스크롤)와 중복 UI(발언 검색)를 제거하고, 하단 툴바 자리를 회의 내 인라인 찾기 바로 교체한다.

**Architecture:** 매칭은 순수 함수(`features/meeting/lib/find-matches.ts`)로 분리하고 `TranscriptPane`이 이를 `useMemo`로 소비한다. 전사는 이미 전부 로드·렌더돼 있으므로 클라이언트 사이드 문자열 매칭이며 서버 왕복이 없다. 현재 매칭 위치는 인덱스가 아니라 **값 앵커**(`{uid,start,end}`)로 들고 인덱스를 파생시켜, 전사가 갱신돼도 카운터와 하이라이트가 어긋나지 않는다.

**Tech Stack:** React 19, TypeScript strict, Vite 8, Tailwind v4 (CSS-first), TanStack Query, Vitest + Testing Library (jsdom).

**설계 문서:** `docs/superpowers/specs/2026-08-15-transcript-find-bar-design.md`

## Global Constraints

- **Node 22 + pnpm 필수** (`engine-strict=true`). 셸이 Node 20이면 명령마다 `nvm use 22 && pnpm ...`.
- **`import type { ... }`** — `verbatimModuleSyntax`가 켜져 있어 타입 전용 import는 반드시 `import type`.
- `noUnusedLocals` / `noUnusedParameters` 활성 — 고아 변수·import가 남으면 `tsc -b`가 실패한다.
- **Prettier:** 큰따옴표, 세미콜론, trailing comma `all`, printWidth 80. 마무리 전 `pnpm format`.
- **UI 문구·커밋 메시지는 한국어.**
- **원시 hex 금지.** 색은 `src/index.css`의 시맨틱 토큰만 사용 (`var(--accent-2)`, `var(--text-muted)` 등).
- **타입 검증의 source of truth는 `pnpm build`의 `tsc -b`** — Vite는 타입 검사를 하지 않는다.
- vitest는 globals 없이 돌므로 RTL 자동 cleanup이 걸리지 않는다 — 각 테스트 파일에 `afterEach(cleanup)`을 명시 등록한다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/features/meeting/lib/find-matches.ts` (신규) | 케이스 폴딩 + 매칭 인덱스 계산. React 무관 순수 함수. |
| `src/features/meeting/lib/find-matches.test.ts` (신규) | 위 순수 함수의 단위 테스트 (인덱스 불변식 포함). |
| `src/features/meeting/ui/transcript-pane.tsx` | 죽은 UI 제거, 찾기 바 렌더, 하이라이트, 앵커 상태, 키보드. |
| `src/features/meeting/ui/transcript-pane.test.tsx` (신규) | 위 컴포넌트 테스트. |
| `src/features/meeting/ui/icons.tsx` | `chevUp`, `x` 아이콘 추가. |
| `src/shared/ui/search-field.tsx` | WebKit 네이티브 클리어 버튼 숨김. |
| `src/pages/meeting.tsx` | `onOpenSearch` 전달과 `useOutletContext` 제거. |
| `src/app/app-shell.tsx` | Outlet 컨텍스트 배선 제거, `openSearch`는 로컬 콜백으로 유지. |

---

### Task 1: 매칭 순수 함수 (`find-matches.ts`)

**Files:**
- Create: `src/features/meeting/lib/find-matches.ts`
- Test: `src/features/meeting/lib/find-matches.test.ts`

**Interfaces:**
- Consumes: `UtteranceEntry` (from `src/features/meeting/model/types.ts`) — 필드 중 이 태스크가 쓰는 것은 `id: string`, `text: string`, `status: "ok" | "transcribe_failed"`.
- Produces:
  - `export type FindMatch = { uid: string; start: number; end: number }`
  - `export function foldCase(s: string): string`
  - `export function findMatches(utterances: UtteranceEntry[], query: string): FindMatch[]`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/features/meeting/lib/find-matches.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { UtteranceEntry } from "../model/types";
import { findMatches, foldCase } from "./find-matches";

function utt(over: Partial<UtteranceEntry> = {}): UtteranceEntry {
  const id = over.id ?? "u1";
  return {
    id,
    spk: 1,
    t: "00:00",
    text: "",
    status: "ok",
    sources: [{ id, startMs: 0 }],
    ...over,
  };
}

describe("foldCase", () => {
  it("ASCII 영문을 소문자로 접는다", () => {
    expect(foldCase("Odysseus")).toBe("odysseus");
  });

  it("한글·ASCII 혼합에서 길이를 보존한다", () => {
    const s = "오디세우스 Lotus 이야기";
    expect(foldCase(s)).toHaveLength(s.length);
  });

  it("폴딩이 길이를 바꾸는 문자(U+0130)에서도 길이를 보존한다", () => {
    // "İstanbul".toLowerCase()는 9자가 된다 — 그대로 쓰면 오프셋이 밀린다.
    const s = "İstanbul";
    expect(s.toLowerCase()).toHaveLength(9);
    expect(foldCase(s)).toHaveLength(8);
  });

  it("서로게이트 페어(이모지)에서도 길이를 보존한다", () => {
    const s = "a\u{1F600}B";
    expect(foldCase(s)).toHaveLength(s.length);
  });
});

describe("findMatches", () => {
  it("빈 질의는 빈 배열", () => {
    expect(findMatches([utt({ text: "로터스" })], "")).toEqual([]);
    expect(findMatches([utt({ text: "로터스" })], "   ")).toEqual([]);
  });

  it("한 발화 안의 모든 출현을 오프셋 순으로 찾는다", () => {
    const u = utt({ text: "로터스와 로터스" });
    expect(findMatches([u], "로터스")).toEqual([
      { uid: "u1", start: 0, end: 3 },
      { uid: "u1", start: 5, end: 8 },
    ]);
  });

  it("대소문자를 무시한다", () => {
    const u = utt({ text: "the Lotus eaters" });
    expect(findMatches([u], "LOTUS")).toEqual([
      { uid: "u1", start: 4, end: 9 },
    ]);
  });

  it("오프셋이 원문 인덱스를 가리킨다 (길이 변하는 폴딩 회귀)", () => {
    // 순진하게 toLowerCase()를 쓰면 İ가 2자로 늘어 오프셋이 1 밀린다.
    const text = "İstanbul 로터스 lotus";
    const [m] = findMatches([utt({ text })], "lotus");
    expect(text.slice(m.start, m.end)).toBe("lotus");
  });

  it("전사 실패 발화는 건너뛴다", () => {
    const failed = utt({ id: "u2", text: "구간", status: "transcribe_failed" });
    expect(findMatches([failed], "구간")).toEqual([]);
  });

  it("여러 발화를 배열 순서대로 이어붙인다", () => {
    const a = utt({ id: "a", text: "로터스" });
    const b = utt({ id: "b", text: "또 로터스" });
    expect(findMatches([a, b], "로터스")).toEqual([
      { uid: "a", start: 0, end: 3 },
      { uid: "b", start: 2, end: 5 },
    ]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/lib/find-matches.test.ts`
Expected: FAIL — `Failed to resolve import "./find-matches"` (파일이 아직 없다)

- [ ] **Step 3: 최소 구현을 작성한다**

`src/features/meeting/lib/find-matches.ts`:

```ts
import type { UtteranceEntry } from "../model/types";

/**
 * 전사 내 찾기(Ctrl+F 계열)의 매칭 계산 — React 무관 순수 함수.
 *
 * 설계 전체가 "폴딩된 문자열의 인덱스 == 원문의 인덱스"라는 불변식 위에 선다.
 * 반환하는 start/end는 항상 **원문** `UtteranceEntry.text`의 인덱스다.
 */

/** 발화 내 매칭 한 건. start/end는 원문 text의 코드 유닛 인덱스. */
export type FindMatch = { uid: string; start: number; end: number };

/**
 * 인덱스 보존 케이스 폴딩 — 결과의 각 인덱스가 원문의 같은 인덱스에 대응한다.
 *
 * 문자열 전체에 `toLowerCase()`를 걸면 길이가 변할 수 있어(U+0130 "İ"는 1자가
 * 2자로) 오프셋이 밀린다. `toLocaleLowerCase()`는 여기에 더해 호스트 로케일까지
 * 탄다(터키 로케일에서 "I" → "ı"). 그래서 코드 포인트 단위로 접되 길이가
 * 변하는 문자는 접지 않는다 — 그런 문자는 대소문자 구분 없이 매칭되지 않지만,
 * 실패 모드가 "매칭 안 됨"이지 "엉뚱한 곳 강조"가 아니다.
 */
export function foldCase(s: string): string {
  let out = "";
  for (const ch of s) {
    // for...of는 코드 포인트 단위 순회라 서로게이트 페어가 쪼개지지 않는다.
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/**
 * 화면에 보이는 순서(발화 순 → 발화 내 오프셋 순)로 매칭을 모은다.
 * 전사 실패 발화는 제외한다 — 화면에 그려지는 건 `text`가 아니라
 * "전사하지 못한 구간입니다"라는 UI 문구라, 포함시키면 카운트가 틀리고
 * 오프셋이 렌더되지 않는 텍스트를 가리킨다.
 */
export function findMatches(
  utterances: UtteranceEntry[],
  query: string,
): FindMatch[] {
  const needle = foldCase(query.trim());
  if (!needle) return [];

  const out: FindMatch[] = [];
  for (const u of utterances) {
    if (u.status === "transcribe_failed") continue;
    const hay = foldCase(u.text);
    let at = hay.indexOf(needle);
    while (at !== -1) {
      out.push({ uid: u.id, start: at, end: at + needle.length });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return out;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/lib/find-matches.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: 타입·린트·포맷을 확인한다**

Run: `nvm use 22 && pnpm build && pnpm lint && pnpm format`
Expected: 모두 성공.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/lib/find-matches.ts src/features/meeting/lib/find-matches.test.ts
git commit -m "feat: 전사 내 찾기 매칭 순수 함수 추가"
```

---

### Task 2: 헤더 우측 죽은 버튼 제거

**Files:**
- Modify: `src/features/meeting/ui/transcript-pane.tsx:424-437`
- Test: `src/features/meeting/ui/transcript-pane.test.tsx` (신규 — 이후 태스크가 이 하네스를 계속 쓴다)

**Interfaces:**
- Consumes: 없음
- Produces: `renderPane(over?: Partial<Meeting>)` 테스트 헬퍼 — 이후 태스크가 재사용한다.

`공유` / `더보기` / `저장` 세 버튼은 `onClick`이 배선돼 있지 않은 순수 장식이다. 셋을 지우면 헤더 우측에 아무것도 남지 않으므로 앞의 `<div className="flex-1" />` 스페이서도 함께 사라진다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/features/meeting/ui/transcript-pane.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Meeting } from "../model/types";

// ResolveDialog가 useSpeakers()를, 헤더 액션들이 mutation을 쓰므로 클라이언트를
// 목킹한다. isApiError도 같은 모듈에서 오므로 함께 내보낸다.
vi.mock("@/shared/api/client", () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
  isApiError: () => false,
}));

const { TranscriptPane } = await import("./transcript-pane");

afterEach(cleanup);

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "mtg_1",
    title: "기획 회의",
    date: "2026-08-11",
    dur: "10:00",
    timeRange: "10:00–10:10",
    files: [],
    aiCount: 0,
    aiHeadline: "",
    aiDetail: "",
    attendees: [1],
    unverified: [],
    fav: false,
    tracks: [],
    utterances: [],
    topics: [],
    segments: [],
    summaryStatus: "done",
    status: "done",
    audioUrl: "",
    totalSeconds: 600,
    speakers: { 1: { id: "spk_1", name: "김영재", role: "PM", spk: 1 } },
    clusters: [],
    ...over,
  };
}

function renderPane(over: Partial<Meeting> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TranscriptPane
        meeting={meeting(over)}
        activeId=""
        onJump={vi.fn()}
        onDeleted={vi.fn()}
        aiAcked
        onAckAi={vi.fn()}
        onShowSummary={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

test("배선되지 않은 헤더 우측 버튼을 렌더하지 않는다", () => {
  renderPane();
  expect(screen.queryByRole("button", { name: "공유" })).toBeNull();
  expect(screen.queryByRole("button", { name: "더보기" })).toBeNull();
  expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
});

test("동작하는 헤더 버튼은 남아 있다", () => {
  renderPane();
  expect(screen.getByRole("button", { name: "즐겨찾기" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이름 변경" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
});
```

> 주의: 이 시점의 `TranscriptPaneProps`에는 아직 `onOpenSearch`가 필수다. 위
> 렌더 헬퍼에 `onOpenSearch={vi.fn()}`를 임시로 추가해야 `tsc -b`가 통과한다.
> Task 3에서 prop을 제거할 때 이 줄도 함께 지운다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: 첫 테스트 FAIL — `공유`·`더보기`·`저장` 버튼이 실제로 존재한다. 둘째 테스트는 PASS.

- [ ] **Step 3: 세 버튼과 스페이서를 제거한다**

`transcript-pane.tsx`에서 아래 블록을 통째로 삭제한다 (재처리 `IconButton`의 닫는 `)}` 바로 다음):

```tsx
          <div className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="jump" size={14} />}
          >
            공유
          </Button>
          <IconButton label="더보기" size="sm">
            <Icon name="more" size={16} />
          </IconButton>
          <IconButton label="저장" size="sm">
            <Icon name="bookmark" size={16} />
          </IconButton>
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: PASS — 2 tests

- [ ] **Step 5: 전체 테스트·타입·린트를 확인한다**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint`
Expected: 모두 성공. `Button`은 `AiBanner`·`VerifyBanner`·다이얼로그에서 계속 쓰므로 import는 남는다.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/ui/transcript-pane.tsx src/features/meeting/ui/transcript-pane.test.tsx
git commit -m "refactor: 배선되지 않은 전사 헤더 우측 버튼 제거"
```

---

### Task 3: 하단 툴바 제거와 고아 배선 정리

**Files:**
- Modify: `src/features/meeting/ui/transcript-pane.tsx` (하단 툴바, `scrollToEnd`, `onOpenSearch` prop)
- Modify: `src/pages/meeting.tsx:4,12,142,335`
- Modify: `src/app/app-shell.tsx:2,25,67-74,116`
- Test: `src/features/meeting/ui/transcript-pane.test.tsx` (Task 2에서 만든 파일)

**Interfaces:**
- Consumes: Task 2의 `renderPane` 헬퍼
- Produces: `TranscriptPaneProps`에서 `onOpenSearch` 제거 — Task 4는 `onOpenSearch` 없는 시그니처를 전제한다.

`발언 검색`은 좌측 레일 검색 필드와 **동일한 콜백**(`openSearch`)을 부르는 중복이고, `전체 스크롤`은 전사 맨 끝으로 점프하는 기능인데 라벨이 맞지 않고 고정 문서에서는 쓸 일이 없다. 둘을 지우면 `onOpenSearch` → `useOutletContext` → Outlet 컨텍스트 배선 전체가 죽은 코드가 되므로 연쇄를 끝까지 정리한다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`transcript-pane.test.tsx`에 추가:

```tsx
test("하단 툴바의 중복·오작동 버튼을 렌더하지 않는다", () => {
  renderPane();
  expect(screen.queryByRole("button", { name: "발언 검색" })).toBeNull();
  expect(screen.queryByRole("button", { name: "전체 스크롤" })).toBeNull();
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: FAIL — 두 버튼이 실제로 존재한다.

- [ ] **Step 3-a: `transcript-pane.tsx`에서 툴바와 관련 배선을 제거한다**

하단 툴바 블록 전체를 삭제한다:

```tsx
      {/* bottom toolbar */}
      <div className="flex shrink-0 items-center justify-between bg-[var(--surface-card)] px-7 py-2">
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Icon name="search" size={14} />}
          onClick={onOpenSearch}
        >
          발언 검색
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconRight={<Icon name="chevDown" size={14} />}
          onClick={scrollToEnd}
        >
          전체 스크롤
        </Button>
      </div>
```

`scrollToEnd` 함수도 삭제한다:

```tsx
  const scrollToEnd = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
```

`TranscriptPaneProps`에서 `onOpenSearch: () => void;` 줄과, 구조분해 목록의 `onOpenSearch,` 줄을 제거한다.

- [ ] **Step 3-b: 테스트 헬퍼에서 임시 prop을 제거한다**

`transcript-pane.test.tsx`의 `renderPane`에서 Task 2에 임시로 넣었던 `onOpenSearch={vi.fn()}` 줄을 삭제한다.

- [ ] **Step 3-c: `src/pages/meeting.tsx`에서 고아 배선을 제거한다**

1. `<TranscriptPane>`의 `onOpenSearch={openSearch}` 줄(335행 부근)을 삭제한다.
2. `const { openSearch } = useOutletContext<ShellOutletContext>();` 줄(142행 부근)을 삭제한다.
3. `react-router` import(4행 부근)에서 `useOutletContext,`를 제거한다.
4. `import type { ShellOutletContext } from "@/app/app-shell";` 줄(12행 부근)을 삭제한다.

- [ ] **Step 3-d: `src/app/app-shell.tsx`에서 Outlet 컨텍스트 배선을 제거한다**

유일한 소비자가 `meeting.tsx`였으므로 컨텍스트 전체가 죽은 코드가 된다. `openSearch`는 `LeftNav`가 계속 쓰므로 평범한 로컬 함수로 남긴다 — memo가 사라지면 `useCallback`도 필요 없다.

삭제할 것:

```tsx
/** 셸이 자식 라우트에 내려주는 것 — ⌘K 팔레트는 셸이 소유한다. */
export type ShellOutletContext = { openSearch: () => void };
```

```tsx
  // 팔레트 열기 진입점은 레일의 검색 필드와 자식 라우트(전사 하단 "발언 검색")
  // 둘인데, 둘 다 이 콜백 하나를 공유한다. 여는 것만 노출해(토글 아님) 열림/닫힘
  // 소유권은 셸에 남긴다.
  const openSearch = React.useCallback(() => setCmdOpen(true), []);
  const outletContext = React.useMemo<ShellOutletContext>(
    () => ({ openSearch }),
    [openSearch],
  );
```

대체할 것:

```tsx
  // 팔레트 열기 진입점은 레일의 검색 필드 하나다. 여는 것만 노출해(토글 아님)
  // 열림/닫힘 소유권은 셸에 남긴다.
  const openSearch = () => setCmdOpen(true);
```

`<Outlet context={outletContext} />` → `<Outlet />`.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: PASS — 3 tests

- [ ] **Step 5: 전체 테스트·타입·린트를 확인한다**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint`
Expected: 모두 성공. `tsc -b`가 `meeting.tsx`·`app-shell.tsx`의 미사용 import를 잡으면 그 import를 지운다.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/ui/transcript-pane.tsx src/features/meeting/ui/transcript-pane.test.tsx src/pages/meeting.tsx src/app/app-shell.tsx
git commit -m "refactor: 전사 하단 툴바와 중복 검색 진입점 제거"
```

---

### Task 4: 찾기 바 UI와 하이라이트

**Files:**
- Modify: `src/features/meeting/ui/icons.tsx:54` (PATHS에 2개 추가)
- Modify: `src/shared/ui/search-field.tsx:20` (`base` 클래스)
- Modify: `src/features/meeting/ui/transcript-pane.tsx`
- Test: `src/features/meeting/ui/transcript-pane.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `findMatches`, `foldCase`, `FindMatch`. Task 3의 `onOpenSearch` 없는 `TranscriptPaneProps`.
- Produces: `TranscriptPane` 내부에 `query`/`anchor` state, `matches`/`cursor`/`current` 파생값, `go(delta: number)` 미구현. Task 5가 `go`를 채운다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`transcript-pane.test.tsx`에 추가한다. 파일 상단 import 두 줄을 고친다:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { Meeting, UtteranceEntry } from "../model/types";
```

그리고 아래를 추가한다:

```tsx
function utt(id: string, text: string, over: Partial<UtteranceEntry> = {}) {
  return {
    id,
    spk: 1,
    t: "00:00",
    text,
    status: "ok" as const,
    sources: [{ id, startMs: 0 }],
    ...over,
  };
}

const LOTUS = [
  utt("u1", "오디세우스가 로터스를 먹는다"),
  utt("u2", "로터스가 자라는 지역과 로터스 열매"),
];

function typeQuery(value: string) {
  const input = screen.getByRole("searchbox", { name: "이 회의에서 찾기" });
  fireEvent.change(input, { target: { value } });
  return input;
}

test("찾기 입력이 항상 보인다", () => {
  renderPane();
  expect(
    screen.getByRole("searchbox", { name: "이 회의에서 찾기" }),
  ).toBeInTheDocument();
});

test("질의가 비어 있으면 카운터와 이동 버튼이 없다", () => {
  renderPane({ utterances: LOTUS });
  expect(screen.queryByRole("button", { name: "다음 결과" })).toBeNull();
});

test("입력하면 모든 매칭을 표시하고 카운터가 1/n을 보여준다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  expect(container.querySelectorAll("mark")).toHaveLength(3);
  expect(screen.getByText("1/3")).toBeInTheDocument();
});

test("현재 매칭에만 data-find-current가 붙는다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  const current = container.querySelectorAll("[data-find-current]");
  expect(current).toHaveLength(1);
  expect(current[0]).toBe(container.querySelectorAll("mark")[0]);
});

test("대소문자를 무시하고 매칭한다", () => {
  const { container } = renderPane({
    utterances: [utt("u1", "the Lotus eaters")],
  });
  typeQuery("LOTUS");
  expect(container.querySelectorAll("mark")).toHaveLength(1);
  expect(container.querySelector("mark")?.textContent).toBe("Lotus");
});

test("İ가 섞여 있어도 마크 경계가 밀리지 않는다", () => {
  const { container } = renderPane({
    utterances: [utt("u1", "İstanbul 로터스 lotus")],
  });
  typeQuery("lotus");
  expect(container.querySelector("mark")?.textContent).toBe("lotus");
});

test("전사 실패 발화의 안내 문구는 매칭되지 않는다", () => {
  const { container } = renderPane({
    utterances: [utt("u1", "무시되는 원문", { status: "transcribe_failed" })],
  });
  typeQuery("구간");
  expect(container.querySelectorAll("mark")).toHaveLength(0);
  expect(screen.getByText("결과 없음")).toBeInTheDocument();
});

test("매칭이 없으면 이동 버튼이 비활성이다", () => {
  renderPane({ utterances: LOTUS });
  typeQuery("없는단어");
  expect(screen.getByRole("button", { name: "다음 결과" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "이전 결과" })).toBeDisabled();
});

test("✕를 누르면 질의와 하이라이트가 사라진다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "찾기 지우기" }));
  expect(container.querySelectorAll("mark")).toHaveLength(0);
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "searchbox"` (찾기 바가 아직 없다)

- [ ] **Step 3-a: 아이콘 두 개를 추가한다**

`src/features/meeting/ui/icons.tsx`의 `PATHS`에 `rotateCw` 다음 줄로 추가:

```ts
  chevUp: "M6 15l6-6 6 6",
  x: "M6 6l12 12M18 6L6 18",
```

- [ ] **Step 3-b: WebKit 네이티브 클리어 버튼을 숨긴다**

`src/shared/ui/search-field.tsx`의 `base` 상수 문자열 끝에 아래 유틸리티를 덧붙인다. `type="search"`라 값이 있을 때 브라우저가 자체 ✕를 그려 우리 버튼과 겹친다.

```
 [&_input::-webkit-search-cancel-button]:appearance-none
```

- [ ] **Step 3-c: `transcript-pane.tsx`에 상태와 하이라이트를 넣는다**

파일 상단 import에 추가:

```tsx
import { cn } from "@/shared/lib/utils";
import { SearchField } from "@/shared/ui/search-field";

import { findMatches, type FindMatch } from "../lib/find-matches";
```

`AttendeePill` 위쪽, 다른 모듈 스코프 헬퍼 옆에 렌더 헬퍼를 둔다:

```tsx
/**
 * 발화 텍스트를 매칭 경계로 쪼개 <mark>로 감싼다. 매칭이 없으면 문자열을
 * 그대로 돌려준다(대부분의 발화가 이 경로).
 */
function renderFindText(
  text: string,
  matches: FindMatch[],
  current: FindMatch | null,
): React.ReactNode {
  if (matches.length === 0) return text;
  const out: React.ReactNode[] = [];
  let at = 0;
  matches.forEach((m, i) => {
    if (m.start > at) out.push(text.slice(at, m.start));
    const isCurrent =
      current != null && current.uid === m.uid && current.start === m.start;
    out.push(
      <mark
        key={i}
        {...(isCurrent ? { "data-find-current": "" } : {})}
        className={cn(
          "rounded-[2px]",
          isCurrent
            ? "bg-[var(--accent-solid)] text-white"
            : "bg-[var(--accent-2)] text-[color:var(--accent-text)]",
        )}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}
```

`TranscriptPane` 본문의 기존 state 선언 아래에 추가:

```tsx
  const [query, setQuery] = React.useState("");
  // 현재 매칭을 인덱스가 아니라 값으로 들고 인덱스를 파생시킨다. matches는
  // meeting.utterances에서 파생되는데 전사는 같은 회의가 마운트된 채로도
  // 바뀐다(화자 확정·재처리·요약 재생성이 ["meeting", id]를 무효화한다).
  // 인덱스를 state로 들면 매칭이 줄었을 때 카운터가 "6/2"가 되고 현재
  // 하이라이트는 아무 데도 붙지 않는다.
  const [anchor, setAnchor] = React.useState<FindMatch | null>(null);
  const findInputRef = React.useRef<HTMLInputElement>(null);

  const matches = React.useMemo(
    () => findMatches(meeting.utterances, query),
    [meeting.utterances, query],
  );

  const cursor = React.useMemo(() => {
    if (!anchor) return 0;
    const i = matches.findIndex(
      (m) =>
        m.uid === anchor.uid &&
        m.start === anchor.start &&
        m.end === anchor.end,
    );
    return i >= 0 ? i : 0; // 앵커가 사라졌으면 첫 매칭으로
  }, [matches, anchor]);

  const current = matches[cursor] ?? null;

  const matchesByUid = React.useMemo(() => {
    const map = new Map<string, FindMatch[]>();
    for (const m of matches) {
      const list = map.get(m.uid);
      if (list) list.push(m);
      else map.set(m.uid, [m]);
    }
    return map;
  }, [matches]);

  const clearFind = () => {
    setQuery("");
    setAnchor(null);
    findInputRef.current?.focus();
  };
```

발화 렌더에서 본문을 하이라이트 대상으로 바꾼다:

```tsx
                {failed
                  ? "전사하지 못한 구간입니다"
                  : renderFindText(u.text, matchesByUid.get(u.id) ?? [], current)}
```

Task 3에서 툴바를 지운 자리(스크롤 본문 `</div>` 다음, 다이얼로그들 앞)에 찾기 바를 넣는다:

```tsx
      {/* 찾기 바 — 회의 내 인라인 검색(브라우저 Ctrl+F 위치·조작감) */}
      <div className="flex shrink-0 items-center gap-1.5 bg-[var(--surface-card)] px-7 py-2">
        <SearchField
          ref={findInputRef}
          className="max-w-[320px] flex-1"
          placeholder="이 회의에서 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() ? (
          <>
            <span
              role="status"
              aria-live="polite"
              className="px-1 text-xs whitespace-nowrap text-[color:var(--text-muted)] tabular-nums"
            >
              {matches.length ? `${cursor + 1}/${matches.length}` : "결과 없음"}
            </span>
            <IconButton
              label="이전 결과"
              size="sm"
              disabled={matches.length === 0}
            >
              <Icon name="chevUp" size={16} />
            </IconButton>
            <IconButton
              label="다음 결과"
              size="sm"
              disabled={matches.length === 0}
            >
              <Icon name="chevDown" size={16} />
            </IconButton>
            <IconButton label="찾기 지우기" size="sm" onClick={clearFind}>
              <Icon name="x" size={16} />
            </IconButton>
          </>
        ) : null}
      </div>
```

> ↑↓ 버튼의 `onClick`은 Task 5에서 붙인다. 이 태스크의 테스트는 존재와
> `disabled`만 검증한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: PASS — 12 tests

- [ ] **Step 5: 전체 테스트·타입·린트·포맷을 확인한다**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint && pnpm format`
Expected: 모두 성공.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/ui/icons.tsx src/shared/ui/search-field.tsx src/features/meeting/ui/transcript-pane.tsx src/features/meeting/ui/transcript-pane.test.tsx
git commit -m "feat: 전사 하단에 회의 내 찾기 바와 매칭 하이라이트 추가"
```

---

### Task 5: 매칭 간 이동과 스크롤

**Files:**
- Modify: `src/features/meeting/ui/transcript-pane.tsx`
- Test: `src/features/meeting/ui/transcript-pane.test.tsx`

**Interfaces:**
- Consumes: Task 4의 `matches`, `cursor`, `current`, `anchor`/`setAnchor`, `findInputRef`
- Produces: `go(delta: number): void` — 순환 이동. Task 6이 키보드에서 재사용한다.

찾기 이동은 **오디오를 옮기지 않는다.** `onJump`은 `?u=`를 세팅해 재생 위치까지 이동시키므로, 매칭을 훑는 동안 호출하면 오디오가 계속 튄다. 스크롤과 하이라이트만 움직인다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`transcript-pane.test.tsx`에 추가:

먼저 헬퍼를 하나 더 둔다 — 같은 QueryClient를 유지한 채 `meeting`만 갈아끼워야 컴포넌트가 리마운트되지 않고 찾기 상태가 살아남는다.

```tsx
/** renderPane과 달리 meeting을 교체해 다시 그릴 수 있다(전사 갱신 재현용). */
function renderUpdatable(over: Partial<Meeting> = {}, onJump = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = (next: Partial<Meeting>) => (
    <QueryClientProvider client={client}>
      <TranscriptPane
        meeting={meeting(next)}
        activeId=""
        onJump={onJump}
        onDeleted={vi.fn()}
        aiAcked
        onAckAi={vi.fn()}
        onShowSummary={vi.fn()}
      />
    </QueryClientProvider>
  );
  const result = render(ui(over));
  return {
    ...result,
    onJump,
    update: (next: Partial<Meeting>) => result.rerender(ui(next)),
  };
}

function currentMarkText(container: HTMLElement) {
  return container.querySelector("[data-find-current]")?.textContent;
}

test("다음 결과를 누르면 카운터와 현재 매칭이 함께 움직인다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(screen.getByText("2/3")).toBeInTheDocument();
  const marks = [...container.querySelectorAll("mark")];
  expect(container.querySelector("[data-find-current]")).toBe(marks[1]);
});

test("마지막 매칭에서 다음을 누르면 처음으로 순환한다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  const next = screen.getByRole("button", { name: "다음 결과" });
  fireEvent.click(next);
  fireEvent.click(next);
  expect(screen.getByText("3/3")).toBeInTheDocument();
  fireEvent.click(next);
  expect(screen.getByText("1/3")).toBeInTheDocument();
  expect(container.querySelector("[data-find-current]")).toBe(
    container.querySelector("mark"),
  );
});

test("첫 매칭에서 이전을 누르면 마지막으로 순환한다", () => {
  renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "이전 결과" }));
  expect(screen.getByText("3/3")).toBeInTheDocument();
});

test("이동해도 오디오·URL을 건드리지 않는다", () => {
  const { onJump } = renderUpdatable({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(onJump).not.toHaveBeenCalled();
});

test("현재 매칭을 화면 가운데로 스크롤한다", () => {
  const spy = vi.spyOn(Element.prototype, "scrollIntoView");
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  spy.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  const marks = [...container.querySelectorAll("mark")];
  expect(spy).toHaveBeenCalledWith({ block: "center" });
  expect(spy.mock.instances[spy.mock.instances.length - 1]).toBe(marks[1]);
  spy.mockRestore();
});

test("전사가 갱신돼도 같은 매칭이 살아 있으면 위치를 유지한다", () => {
  const { update } = renderUpdatable({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(screen.getByText("2/3")).toBeInTheDocument();

  // 같은 내용의 새 배열 — 재조회가 동일 데이터를 돌려주는 흔한 경우.
  update({ utterances: LOTUS.map((u) => ({ ...u })) });
  expect(screen.getByText("2/3")).toBeInTheDocument();
});

test("현재 매칭이 사라진 전사로 갱신되면 카운터와 하이라이트가 함께 앞으로 간다", () => {
  const { container, update } = renderUpdatable({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(screen.getByText("2/3")).toBeInTheDocument();

  // u2가 "로터스" 하나만 남도록 재처리된 상황 — 매칭 3개 → 2개.
  update({ utterances: [LOTUS[0], utt("u2", "로터스만 남았다")] });
  expect(screen.getByText("1/2")).toBeInTheDocument();
  expect(container.querySelectorAll("[data-find-current]")).toHaveLength(1);
  expect(currentMarkText(container)).toBe("로터스");
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: 이동 관련 테스트 FAIL — ↑↓ 버튼에 `onClick`이 없어 카운터가 `1/3`에 머문다.

- [ ] **Step 3-a: `go`와 스크롤 effect를 추가한다**

Task 4에서 넣은 `clearFind` 옆에:

```tsx
  /** 매칭 간 순환 이동. 오디오·URL은 건드리지 않는다(Ctrl+F 의미론). */
  const go = (delta: number) => {
    if (matches.length === 0) return;
    setAnchor(matches[(cursor + delta + matches.length) % matches.length]);
  };
```

기존 `activeId` 스크롤 effect 아래에 찾기 전용 effect를 둔다. 발화 블록이 아니라 `<mark>` 자체를 기준으로 삼아야 긴 병합 블록에서도 매칭이 가운데에 온다. 포커스는 옮기지 않는다 — 입력에 계속 타이핑할 수 있어야 한다.

```tsx
  React.useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>("[data-find-current]")
      ?.scrollIntoView({ block: "center" });
  }, [cursor, matches]);
```

- [ ] **Step 3-b: ↑↓ 버튼에 배선한다**

Task 4에서 넣은 두 `IconButton`에 `onClick`을 더한다:

```tsx
            <IconButton
              label="이전 결과"
              size="sm"
              disabled={matches.length === 0}
              onClick={() => go(-1)}
            >
```

```tsx
            <IconButton
              label="다음 결과"
              size="sm"
              disabled={matches.length === 0}
              onClick={() => go(1)}
            >
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: PASS — 19 tests

- [ ] **Step 5: 전체 테스트·타입·린트를 확인한다**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint`
Expected: 모두 성공.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/ui/transcript-pane.tsx src/features/meeting/ui/transcript-pane.test.tsx
git commit -m "feat: 찾기 결과 간 순환 이동과 현재 매칭 스크롤"
```

---

### Task 6: 키보드 단축키 (⌘F · Enter · Esc)

**Files:**
- Modify: `src/features/meeting/ui/transcript-pane.tsx`
- Test: `src/features/meeting/ui/transcript-pane.test.tsx`

**Interfaces:**
- Consumes: Task 5의 `go`, Task 4의 `query`/`setQuery`/`setAnchor`/`findInputRef`
- Produces: 없음 (마지막 태스크)

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`transcript-pane.test.tsx`에 추가:

```tsx
test("Enter로 다음, Shift+Enter로 이전 매칭으로 간다", () => {
  renderPane({ utterances: LOTUS });
  const input = typeQuery("로터스");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("2/3")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(screen.getByText("1/3")).toBeInTheDocument();
});

test("↓↑ 키로도 이동한다", () => {
  renderPane({ utterances: LOTUS });
  const input = typeQuery("로터스");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByText("2/3")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(screen.getByText("1/3")).toBeInTheDocument();
});

test("Esc는 질의를 비운다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  const input = typeQuery("로터스");
  fireEvent.keyDown(input, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("");
  expect(container.querySelectorAll("mark")).toHaveLength(0);
});

test("⌘F가 찾기 입력을 선택한다", () => {
  renderPane({ utterances: LOTUS });
  const input = screen.getByRole("searchbox", { name: "이 회의에서 찾기" });
  const select = vi.spyOn(input as HTMLInputElement, "select");
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(select).toHaveBeenCalled();
});

test("모달이 열려 있으면 ⌘F를 가로채지 않는다", () => {
  renderPane({ utterances: LOTUS });
  const input = screen.getByRole("searchbox", { name: "이 회의에서 찾기" });
  const select = vi.spyOn(input as HTMLInputElement, "select");

  // Radix 다이얼로그가 열린 상태를 흉내 낸다 — 포커스 트랩과 싸우면 안 된다.
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("data-state", "open");
  document.body.appendChild(modal);

  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(select).not.toHaveBeenCalled();

  modal.remove();
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: FAIL — 키보드 핸들러가 아직 없어 카운터가 `1/3`에 머물고 `select`가 호출되지 않는다.

- [ ] **Step 3-a: 입력 키 핸들러를 추가한다**

`go` 아래에:

```tsx
  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "Escape") {
      if (query) {
        setQuery("");
        setAnchor(null);
      } else {
        e.currentTarget.blur();
      }
    }
  };
```

`SearchField`에 배선한다:

```tsx
          onKeyDown={onFindKeyDown}
```

- [ ] **Step 3-b: ⌘F 가로채기 effect를 추가한다**

```tsx
  // ⌘F/Ctrl+F로 찾기 입력에 진입한다. 회의 화면에서만 마운트되므로 다른
  // 라우트에는 영향이 없다. 모달이 열려 있으면 가로채지 않는다 — Radix
  // 포커스 트랩이 focus()를 되뺏어가며 싸우므로, 그땐 브라우저 기본 찾기에
  // 양보한다. role="dialog" + data-state는 Radix가 항상 세우는 공개 계약이다.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      findInputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `nvm use 22 && pnpm vitest run src/features/meeting/ui/transcript-pane.test.tsx`
Expected: PASS — 24 tests

- [ ] **Step 5: 전체 검증**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint && pnpm format`
Expected: 모두 성공.

- [ ] **Step 6: 실제 앱에서 확인한다**

Run: `nvm use 22 && pnpm dev`
확인할 것:
1. 회의 화면 헤더 우측에 버튼이 없다.
2. 하단에 `이 회의에서 찾기` 입력이 보인다.
3. 단어를 입력하면 전사 전체가 하이라이트되고 첫 매칭이 진한 색으로 화면 가운데 온다.
4. ↓/Enter로 이동하면 카운터가 따라 움직이고 **오디오 재생 위치는 그대로다.**
5. ⌘F로 입력에 포커스가 가고, Esc로 비워진다.
6. 회의를 바꾸면 질의가 초기화된다.

- [ ] **Step 7: 커밋**

```bash
git add src/features/meeting/ui/transcript-pane.tsx src/features/meeting/ui/transcript-pane.test.tsx
git commit -m "feat: 찾기 바 키보드 단축키(⌘F·Enter·Esc) 추가"
```

---

## 스펙 커버리지 확인

| 스펙 항목 | 태스크 |
|---|---|
| `icons.tsx` — `chevUp`·`x` 추가 | Task 4 Step 3-a |
| `search-field.tsx` — WebKit 클리어 버튼 숨김 | Task 4 Step 3-b |
| `find-matches.ts` — `FindMatch`·`foldCase`·`findMatches` | Task 1 |
| 매칭 인덱스 (실패 발화 제외, 발화 텍스트만, 화면 순서) | Task 1 Step 3 |
| 길이 보존 케이스 폴딩 + 인덱스 불변식 테스트 | Task 1 |
| 헤더 우측 3버튼 + 스페이서 제거 | Task 2 |
| 하단 툴바·`scrollToEnd` 제거 | Task 3 Step 3-a |
| 고아 배선 연쇄 정리 (`meeting.tsx`, `app-shell.tsx`) | Task 3 Step 3-c·3-d |
| 앵커 기반 `cursor` 파생 | Task 4 Step 3-c |
| 하이라이트 렌더 (`<mark>`, 현재 매칭 구분) | Task 4 Step 3-c |
| 찾기 바 마크업 (버튼은 label 밖 형제) | Task 4 Step 3-c |
| 카운터 `role="status" aria-live="polite"` | Task 4 Step 3-c |
| 현재 매칭 `scrollIntoView({block:"center"})` | Task 5 Step 3-a |
| 순환 이동, 오디오 불변 | Task 5 |
| 전사 갱신 시 카운터·하이라이트 일치 | Task 5 Step 1 (마지막 두 테스트) |
| 키보드 표 (Enter/Shift+Enter/↑↓/Esc) | Task 6 Step 3-a |
| ⌘F 가로채기 + 모달 가드 | Task 6 Step 3-b |
| 회의 전환 시 초기화 (`MeetingView key`로 이미 커버) | 코드 변경 없음 — Task 6 Step 6에서 수동 확인 |
