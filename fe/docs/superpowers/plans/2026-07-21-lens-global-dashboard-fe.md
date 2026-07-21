# 전역 렌즈 대시보드 (FE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/app` 셸의 "모든 회의" 뷰에 있는 "준비 중" placeholder `LensView`를, 모든 회의의 렌즈를 조회·필터·완료 처리하고 근거 발언으로 이동하는 실제 대시보드로 교체한다.

**Architecture:** 신규 `features/lens/` 모듈(model·api·ui)을 만들고 `meeting.tsx`가 `LensView` 대신 `LensDashboard`를 렌더한다. 데이터는 기존 렌즈 REST API(react-query)로 가져오고, 근거 점프는 상위 셸(`meeting.tsx`)의 뷰/발언 상태를 통해 처리한다.

**Tech Stack:** React 19, react-router, @tanstack/react-query(useInfiniteQuery), axios(`apiClient`), Tailwind, vitest + @testing-library/react.

## Global Constraints

- Node는 `.nvmrc` 버전(`nvm use`). 패키지 매니저 pnpm.
- API 호출은 `@/shared/api/client`의 `apiClient`(axios)만 사용. 실패는 `ApiError`로 정규화됨.
- 렌즈 kind는 **`action|decision|promise` 3종만**. `topic`은 절대 포함하지 않는다(BE `GET /lenses` kind enum이 거부; `topic`은 작업 4). 기존 `features/meeting/model`의 `LENS_META`(topic 포함)를 재사용하지 않는다.
- BE `completion_status` 필터는 단일값(`open`|`done`, 기본 `open`)이라 "열림+완료 동시" 조회가 없다. 완료 필터는 `열림|완료` 세그먼트(둘 중 하나)로 만든다.
- primary 근거는 응답의 `evidence` 배열에서 `find(e => e.relation === 'primary')`로 얻는다(별도 필드 없음).
- 근거 점프는 오디오 seek를 하지 않는다(스크롤·하이라이트만). 재처리 전 발언은 현재 transcript에 없으므로 토스트로 안내한다.
- 기존 `LensItem`(`@/shared/ui/lens-item`)을 그대로 재사용한다(변경 없음). `formatClock(ms)`은 `@/features/meeting/api/mappers`에 있다.

---

### Task 1: 렌즈 모델·API 훅

**Files:**
- Create: `src/features/lens/model/types.ts`
- Create: `src/features/lens/model/meta.ts`
- Create: `src/features/lens/api/lenses.ts`
- Test: `src/features/lens/api/lenses.test.tsx`

**Interfaces:**
- Consumes: `apiClient`(`@/shared/api/client`).
- Produces:
  - `LensKind = 'action' | 'decision' | 'promise'`
  - `LensWireItem`, `LensListPage`, `LensFilters`, `ExtractionStatus`(아래 정의)
  - `LENS_KINDS: LensKind[]`, `LENS_META: Record<LensKind,{label:string;icon:IconName}>`
  - `useLensList(filters: LensFilters)` → `UseInfiniteQueryResult<LensListPage>`
  - `useLensExtractionStatus()` → `UseQueryResult<ExtractionStatus>`
  - `useSetLensCompletion()` → mutation `{ id: string; done: boolean }`
  - `useRetryExtraction()` → mutation `meetingId: string`

- [ ] **Step 1: Create the model types**

Create `src/features/lens/model/types.ts`:

```ts
export type LensKind = "action" | "decision" | "promise";
export type LensSource = "ai" | "user" | "edited";
export type LensCompletionStatus = "open" | "done";
export type EvidenceRelation = "primary" | "supporting";

export type WireUtterance = {
  id: string;
  start_ms: number;
  text: string;
  speaker_id: string | null;
};

export type WireEvidence = { relation: EvidenceRelation; utterance: WireUtterance };

export type LensWireItem = {
  id: string;
  kind: LensKind;
  text: string;
  source: LensSource;
  user_modified: boolean;
  completion_status: LensCompletionStatus;
  lifecycle_status: "active" | "archived";
  meeting_id: string;
  assignee_speaker_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  meeting: { id: string; title: string | null };
  evidence: WireEvidence[];
};

export type LensListPage = { items: LensWireItem[]; next_cursor: string | null };

export type LensFilters = {
  kind: LensKind;
  completion_status: LensCompletionStatus;
  speaker_id?: string;
  meeting_id?: string;
  date_from?: string;
  date_to?: string;
};

export type ExtractionStatus = {
  running: number;
  failed: { meeting_id: string; title: string | null }[];
};
```

- [ ] **Step 2: Create the kind meta (3 kinds only)**

Create `src/features/lens/model/meta.ts`:

```ts
import type { IconName } from "@/features/meeting/ui/icons";
import type { LensKind } from "./types";

// 작업 3은 action|decision|promise만. topic(주제·키워드)은 작업 4에서 별도 탭으로 추가.
export const LENS_META: Record<LensKind, { label: string; icon: IconName }> = {
  action: { label: "액션아이템", icon: "listChecks" },
  decision: { label: "결정사항", icon: "scale" },
  promise: { label: "약속·책임", icon: "handshake" },
};

export const LENS_KINDS = Object.keys(LENS_META) as LensKind[];
```

- [ ] **Step 3: Write the failing hook tests**

Create `src/features/lens/api/lenses.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { useLensList, useLensExtractionStatus } from "./lenses";
import type { LensListPage, ExtractionStatus } from "../model/types";

afterEach(() => vi.restoreAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const PAGE: LensListPage = { items: [], next_cursor: null };

test("useLensList가 필터를 쿼리스트링으로 GET /lenses 호출한다", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: PAGE } as never);
  const { result } = renderHook(
    () => useLensList({ kind: "action", completion_status: "open", speaker_id: "spk_2" }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const url = get.mock.calls[0][0] as string;
  expect(url).toContain("/lenses?");
  expect(url).toContain("kind=action");
  expect(url).toContain("completion_status=open");
  expect(url).toContain("speaker_id=spk_2");
});

test("useLensExtractionStatus가 GET /lenses/extraction-status를 조회한다", async () => {
  const status: ExtractionStatus = { running: 2, failed: [] };
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: status } as never);
  const { result } = renderHook(() => useLensExtractionStatus(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/lenses/extraction-status");
  expect(result.current.data?.running).toBe(2);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run src/features/lens/api/lenses.test.tsx`
Expected: FAIL — `./lenses` 모듈/export 없음.

- [ ] **Step 5: Implement the API hooks**

Create `src/features/lens/api/lenses.ts`:

```ts
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type {
  ExtractionStatus,
  LensFilters,
  LensListPage,
} from "../model/types";

function toQuery(filters: LensFilters, cursor: string | null): string {
  const p = new URLSearchParams();
  p.set("kind", filters.kind);
  p.set("completion_status", filters.completion_status);
  if (filters.speaker_id) p.set("speaker_id", filters.speaker_id);
  if (filters.meeting_id) p.set("meeting_id", filters.meeting_id);
  if (filters.date_from) p.set("date_from", filters.date_from);
  if (filters.date_to) p.set("date_to", filters.date_to);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export function useLensList(filters: LensFilters) {
  return useInfiniteQuery({
    queryKey: ["lenses", filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const { data } = await apiClient.get<LensListPage>(
        `/lenses?${toQuery(filters, pageParam)}`,
      );
      return data;
    },
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function useLensExtractionStatus() {
  return useQuery({
    queryKey: ["lens-extraction-status"],
    queryFn: async () => {
      const { data } = await apiClient.get<ExtractionStatus>(
        "/lenses/extraction-status",
      );
      return data;
    },
    // 대시보드가 열려 있는 동안 상시 폴링 — idle/실패 상태에서 새 자동 추출도 포착.
    refetchInterval: 10_000,
  });
}

// 완료/재열기. 완료된 항목은 현재(열림) 목록에서 빠지므로 낙관적으로 제거하고,
// 실패 시 롤백한다.
export function useSetLensCompletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; done: boolean }) => {
      const path = v.done ? `/lenses/${v.id}/complete` : `/lenses/${v.id}/reopen`;
      const { data } = await apiClient.post(path);
      return data;
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["lenses"] });
      const prev = qc.getQueriesData<{ pages: LensListPage[]; pageParams: unknown[] }>({
        queryKey: ["lenses"],
      });
      qc.setQueriesData<{ pages: LensListPage[]; pageParams: unknown[] }>(
        { queryKey: ["lenses"] },
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              items: pg.items.filter((it) => it.id !== v.id),
            })),
          },
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["lenses"] }),
  });
}

export function useRetryExtraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) =>
      apiClient.post(`/meetings/${meetingId}/lenses/extract`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lens-extraction-status"] });
      qc.invalidateQueries({ queryKey: ["lenses"] });
    },
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/features/lens/api/lenses.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/lens/model src/features/lens/api/lenses.ts src/features/lens/api/lenses.test.tsx
git commit -m "feat(lens): add global lens dashboard model and api hooks"
```

---

### Task 2: 렌즈 행 매핑 + 목록(무한 스크롤)

**Files:**
- Create: `src/features/lens/lib/map-item.ts`
- Create: `src/features/lens/ui/lens-list.tsx`
- Test: `src/features/lens/lib/map-item.test.ts`

**Interfaces:**
- Consumes: `LensWireItem`(Task 1), `LensItem`(`@/shared/ui/lens-item`), `useSpeakers`(`@/features/speaker/api/speakers`), `formatClock`(`@/features/meeting/api/mappers`).
- Produces:
  - `mapItemView(item: LensWireItem): { source: "ai"|"user"|"edited"|"hint"; primary: { utteranceId: string; startMs: number } | null; timecode: string | null }`
  - `LensList` 컴포넌트 props: `{ pages: LensListPage[]; hasNextPage: boolean; isFetchingNextPage: boolean; onLoadMore: () => void; onToggle: (id: string, done: boolean) => void; onJumpEvidence: (meetingId: string, utteranceId: string) => void; speakerName: (id: string | null) => string | null; speakerTint: (id: string | null) => number | undefined }`

- [ ] **Step 1: Write the failing mapper test**

Create `src/features/lens/lib/map-item.test.ts`:

```ts
import { expect, test } from "vitest";
import { mapItemView } from "./map-item";
import type { LensWireItem } from "../model/types";

const base: LensWireItem = {
  id: "lens_1", kind: "action", text: "문서 작성", source: "ai",
  user_modified: false, completion_status: "open", lifecycle_status: "active",
  meeting_id: "mtg_1", assignee_speaker_id: null, due_at: null,
  created_at: "", updated_at: "", meeting: { id: "mtg_1", title: "회의" },
  evidence: [],
};

test("primary 근거가 있으면 timecode와 primary를 만든다", () => {
  const v = mapItemView({
    ...base,
    evidence: [{ relation: "primary", utterance: { id: "utt_9", start_ms: 65000, text: "x", speaker_id: null } }],
  });
  expect(v.source).toBe("ai");
  expect(v.primary).toEqual({ utteranceId: "utt_9", startMs: 65000 });
  expect(v.timecode).toBe("01:05");
});

test("AI 출처인데 primary 근거가 없으면 hint(확인 필요)", () => {
  const v = mapItemView({ ...base, source: "ai", evidence: [] });
  expect(v.source).toBe("hint");
  expect(v.primary).toBeNull();
  expect(v.timecode).toBeNull();
});

test("사용자 출처는 근거 없어도 hint가 아니다", () => {
  const v = mapItemView({ ...base, source: "user", evidence: [] });
  expect(v.source).toBe("user");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/features/lens/lib/map-item.test.ts`
Expected: FAIL — `./map-item` 없음.

- [ ] **Step 3: Implement the mapper**

Create `src/features/lens/lib/map-item.ts`:

```ts
import { formatClock } from "@/features/meeting/api/mappers";
import type { LensWireItem } from "../model/types";

export type LensItemView = {
  source: "ai" | "user" | "edited" | "hint";
  primary: { utteranceId: string; startMs: number } | null;
  timecode: string | null;
};

export function mapItemView(item: LensWireItem): LensItemView {
  const primaryEv = item.evidence.find((e) => e.relation === "primary") ?? null;
  const primary = primaryEv
    ? { utteranceId: primaryEv.utterance.id, startMs: primaryEv.utterance.start_ms }
    : null;
  // 근거가 사라진 보존 AI 항목 → "확인 필요"(품질조건). 사용자/수정 항목은 유지.
  const source = item.source === "ai" && !primary ? "hint" : item.source;
  return { source, primary, timecode: primary ? formatClock(primary.startMs) : null };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/features/lens/lib/map-item.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the list component**

Create `src/features/lens/ui/lens-list.tsx`:

```tsx
import * as React from "react";
import { LensItem } from "@/shared/ui/lens-item";
import type { LensListPage } from "../model/types";
import { mapItemView } from "../lib/map-item";

type LensListProps = {
  pages: LensListPage[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onToggle: (id: string, done: boolean) => void;
  onJumpEvidence: (meetingId: string, utteranceId: string) => void;
  speakerName: (id: string | null) => string | null;
  speakerTint: (id: string | null) => number | undefined;
};

export function LensList({
  pages, hasNextPage, isFetchingNextPage, onLoadMore,
  onToggle, onJumpEvidence, speakerName, speakerTint,
}: LensListProps) {
  const sentinel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) onLoadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  const items = pages.flatMap((p) => p.items);

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        const v = mapItemView(item);
        const name = speakerName(item.assignee_speaker_id);
        return (
          <LensItem
            key={item.id}
            source={v.source}
            checkable
            done={item.completion_status === "done"}
            onToggle={() => onToggle(item.id, item.completion_status !== "done")}
            assignee={name ?? undefined}
            assigneeSpeaker={speakerTint(item.assignee_speaker_id)}
            evidence={v.timecode ?? undefined}
            onJump={
              v.primary
                ? () => onJumpEvidence(item.meeting_id, v.primary!.utteranceId)
                : undefined
            }
          >
            {item.text}
          </LensItem>
        );
      })}
      <div ref={sentinel} aria-hidden className="h-px" />
      {isFetchingNextPage && (
        <p className="py-2 text-center text-sm text-[color:var(--text-muted)]">
          더 불러오는 중…
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add src/features/lens/lib src/features/lens/ui/lens-list.tsx
git commit -m "feat(lens): add item mapping and infinite-scroll list"
```

---

### Task 3: 필터 바

**Files:**
- Create: `src/features/lens/ui/lens-filter-bar.tsx`

**Interfaces:**
- Consumes: `LensFilters`(Task 1), `useSpeakers`, `useMeetings`(`@/features/meeting/api/meetings`), `Select`(`@/shared/ui/select`), `DatePicker`(`@/shared/ui/date-picker`).
- Produces: `LensFilterBar` props `{ filters: LensFilters; onChange: (patch: Partial<LensFilters>) => void }`.

- [ ] **Step 1: Implement the filter bar**

Create `src/features/lens/ui/lens-filter-bar.tsx`. 완료는 `열림|완료` 세그먼트(BE 단일값 제약), 기간은 due_at 기준 from~to, 화자·회의는 Select. 화자/회의 옵션은 각 쿼리에서 채운다.

```tsx
import { useMeetings } from "@/features/meeting/api/meetings";
import { useSpeakers } from "@/features/speaker/api/speakers";
import { DatePicker } from "@/shared/ui/date-picker";
import { Select } from "@/shared/ui/select";
import type { LensCompletionStatus, LensFilters } from "../model/types";

type Props = {
  filters: LensFilters;
  onChange: (patch: Partial<LensFilters>) => void;
};

export function LensFilterBar({ filters, onChange }: Props) {
  const speakers = useSpeakers();
  const meetings = useMeetings();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-sm border border-border p-0.5" role="group" aria-label="완료 상태">
        {(["open", "done"] as LensCompletionStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filters.completion_status === s}
            onClick={() => onChange({ completion_status: s })}
            className={
              "rounded-xs px-2.5 py-1 text-sm " +
              (filters.completion_status === s
                ? "bg-[var(--gray-2)] font-medium text-foreground"
                : "text-[color:var(--text-muted)]")
            }
          >
            {s === "open" ? "열림" : "완료"}
          </button>
        ))}
      </div>

      <DatePicker
        value={filters.date_from ?? ""}
        onChange={(v) => onChange({ date_from: v || undefined })}
        aria-label="기한 시작"
      />
      <DatePicker
        value={filters.date_to ?? ""}
        onChange={(v) => onChange({ date_to: v || undefined })}
        aria-label="기한 끝"
      />

      <Select
        aria-label="화자"
        value={filters.speaker_id ?? ""}
        onChange={(e) => onChange({ speaker_id: e.target.value || undefined })}
      >
        <option value="">모든 화자</option>
        {(speakers.data ?? []).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </Select>

      <Select
        aria-label="회의"
        value={filters.meeting_id ?? ""}
        onChange={(e) => onChange({ meeting_id: e.target.value || undefined })}
      >
        <option value="">모든 회의</option>
        {(meetings.data ?? []).map((m) => (
          <option key={m.id} value={m.id}>{m.title}</option>
        ))}
      </Select>
    </div>
  );
}
```

Note: `DatePicker`/`Select`의 실제 prop 시그니처를 확인해 맞춘다(`src/shared/ui/date-picker.tsx`, `src/shared/ui/select.tsx`). 위는 value/onChange 계약을 가정하며, 다르면 그 컴포넌트의 계약에 맞춰 어댑트한다.

- [ ] **Step 2: Type-check**

Run: `pnpm tsc -b --noEmit` (또는 프로젝트의 타입체크 스크립트)
Expected: 에러 없음. `DatePicker`/`Select` prop 불일치가 나면 시그니처에 맞춰 수정.

- [ ] **Step 3: Commit**

```bash
git add src/features/lens/ui/lens-filter-bar.tsx
git commit -m "feat(lens): add dashboard filter bar"
```

---

### Task 4: 추출 상태 배너

**Files:**
- Create: `src/features/lens/ui/lens-extraction-banner.tsx`
- Test: `src/features/lens/ui/lens-extraction-banner.test.tsx`

**Interfaces:**
- Consumes: `useLensExtractionStatus`, `useRetryExtraction`(Task 1).
- Produces: `LensExtractionBanner` (props 없음; 훅 자체 구독).

- [ ] **Step 1: Write the failing test**

Create `src/features/lens/ui/lens-extraction-banner.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { LensExtractionBanner } from "./lens-extraction-banner";

afterEach(() => vi.restoreAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("실패 회의에 재시도 버튼을 렌더하고 클릭 시 extract를 호출한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { running: 0, failed: [{ meeting_id: "mtg_7", title: "주간 스크럼" }] },
  } as never);
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);

  render(<LensExtractionBanner />, { wrapper });
  const btn = await screen.findByRole("button", { name: /재시도/ });
  await userEvent.click(btn);
  expect(post).toHaveBeenCalledWith("/meetings/mtg_7/lenses/extract");
});

test("진행중도 실패도 없으면 아무것도 렌더하지 않는다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { running: 0, failed: [] },
  } as never);
  const { container } = render(<LensExtractionBanner />, { wrapper });
  await screen.findByTestId("banner-root").catch(() => null);
  expect(container.querySelector("[data-testid='banner-root']")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/features/lens/ui/lens-extraction-banner.test.tsx`
Expected: FAIL — 컴포넌트 없음.

- [ ] **Step 3: Implement the banner**

Create `src/features/lens/ui/lens-extraction-banner.tsx`:

```tsx
import { useLensExtractionStatus, useRetryExtraction } from "../api/lenses";

export function LensExtractionBanner() {
  const status = useLensExtractionStatus();
  const retry = useRetryExtraction();
  const data = status.data;
  if (!data || (data.running === 0 && data.failed.length === 0)) return null;

  return (
    <div data-testid="banner-root" className="flex flex-col gap-1.5">
      {data.running > 0 && (
        <div className="rounded-sm bg-[var(--accent-1)] px-3 py-2 text-sm text-[color:var(--accent-text)]">
          렌즈 추출 {data.running}건 진행 중…
        </div>
      )}
      {data.failed.map((f) => (
        <div
          key={f.meeting_id}
          className="flex items-center justify-between rounded-sm bg-[var(--amber-bg)] px-3 py-2 text-sm text-[color:var(--amber-text)]"
        >
          <span>추출 실패: {f.title ?? "제목 없는 회의"}</span>
          <button
            type="button"
            onClick={() => retry.mutate(f.meeting_id)}
            disabled={retry.isPending}
            className="rounded-xs border border-current px-2 py-0.5 text-2xs font-medium disabled:opacity-50"
          >
            재시도
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/features/lens/ui/lens-extraction-banner.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/lens/ui/lens-extraction-banner.tsx src/features/lens/ui/lens-extraction-banner.test.tsx
git commit -m "feat(lens): add extraction status banner with retry"
```

---

### Task 5: 대시보드 셸(탭 + 조합)

**Files:**
- Create: `src/features/lens/ui/lens-dashboard.tsx`

**Interfaces:**
- Consumes: Task 1–4 산출물, `useSpeakers`, `Tabs`(`@/shared/ui/tabs`), `Icon`(`@/features/meeting/ui/icons`), `LENS_KINDS`/`LENS_META`(Task 1).
- Produces: `LensDashboard` props `{ lens: LensKind; onLens: (k: LensKind) => void; onJumpEvidence: (meetingId: string, utteranceId: string) => void }`.

- [ ] **Step 1: Implement the dashboard shell**

Create `src/features/lens/ui/lens-dashboard.tsx`. 필터 상태는 대시보드가 소유하고, kind는 상위(meeting.tsx)에서 내려온 `lens`를 사용한다. 화자 tint는 화자 목록 순번(1..n)으로 매핑한다.

```tsx
import * as React from "react";
import { useSpeakers } from "@/features/speaker/api/speakers";
import { Icon } from "@/features/meeting/ui/icons";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { LENS_KINDS, LENS_META } from "../model/meta";
import type { LensFilters, LensKind } from "../model/types";
import {
  useLensList,
  useSetLensCompletion,
} from "../api/lenses";
import { LensFilterBar } from "./lens-filter-bar";
import { LensExtractionBanner } from "./lens-extraction-banner";
import { LensList } from "./lens-list";

type Props = {
  lens: LensKind;
  onLens: (k: LensKind) => void;
  onJumpEvidence: (meetingId: string, utteranceId: string) => void;
};

export function LensDashboard({ lens, onLens, onJumpEvidence }: Props) {
  const [filters, setFilters] = React.useState<Omit<LensFilters, "kind">>({
    completion_status: "open",
  });
  const full: LensFilters = { kind: lens, ...filters };
  const list = useLensList(full);
  const completion = useSetLensCompletion();

  const speakers = useSpeakers();
  const speakerIndex = React.useMemo(() => {
    const map = new Map<string, number>();
    (speakers.data ?? []).forEach((s, i) => map.set(s.id, i + 1));
    return map;
  }, [speakers.data]);
  const speakerName = (id: string | null) =>
    id ? (speakers.data ?? []).find((s) => s.id === id)?.name ?? null : null;
  const speakerTint = (id: string | null) =>
    id ? speakerIndex.get(id) : undefined;

  const meta = LENS_META[lens];
  const pages = list.data?.pages ?? [];
  const isEmpty = list.isSuccess && pages.every((p) => p.items.length === 0);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-app)]">
      <div className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-7 pt-[18px] pb-3.5">
        <div className="flex items-center gap-[9px]">
          <span className="inline-flex text-[color:var(--text-secondary)]">
            <Icon name={meta.icon} size={19} />
          </span>
          <h1 className="text-h2 font-semibold tracking-[-0.01em] text-foreground">
            내 {meta.label}
          </h1>
        </div>
        <div className="mt-3">
          <Tabs value={lens} onValueChange={(v) => onLens(v as LensKind)} className="gap-0">
            <TabsList>
              {LENS_KINDS.map((k) => (
                <TabsTrigger key={k} value={k}>
                  {LENS_META[k].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="mt-3">
          <LensFilterBar
            filters={full}
            onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          <LensExtractionBanner />
          {list.isLoading && (
            <p className="py-8 text-center text-sm text-[color:var(--text-muted)]">불러오는 중…</p>
          )}
          {list.isError && (
            <div className="py-8 text-center text-sm text-[color:var(--text-muted)]">
              목록을 불러오지 못했어요.
              <button type="button" onClick={() => list.refetch()} className="ml-2 underline">
                다시 시도
              </button>
            </div>
          )}
          {isEmpty && (
            <p className="py-8 text-center text-sm text-[color:var(--text-muted)]">
              조건에 맞는 {meta.label} 항목이 없어요.
            </p>
          )}
          {!isEmpty && (
            <LensList
              pages={pages}
              hasNextPage={!!list.hasNextPage}
              isFetchingNextPage={list.isFetchingNextPage}
              onLoadMore={() => list.fetchNextPage()}
              onToggle={(id, done) => completion.mutate({ id, done })}
              onJumpEvidence={onJumpEvidence}
              speakerName={speakerName}
              speakerTint={speakerTint}
            />
          )}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Type-check**

Run: 프로젝트 타입체크. Expected: 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/features/lens/ui/lens-dashboard.tsx
git commit -m "feat(lens): assemble global lens dashboard shell"
```

---

### Task 6: `meeting.tsx` 통합 + 근거 점프(seek 없음, historical 가드)

**Files:**
- Modify: `src/pages/meeting.tsx` (LensView → LensDashboard, jumpToEvidence 추가)
- Modify: `src/features/meeting/model/types.ts` (LensKind에서 topic 제거 — 아래 주의)
- Modify: `src/features/meeting/model/data.ts` (topic 항목 제거)
- Delete: `src/features/meeting/ui/lens-view.tsx` (placeholder 대체됨)
- Test: `src/pages/meeting.test.tsx` (근거 점프 케이스 추가)

**Interfaces:**
- Consumes: `LensDashboard`(Task 5), 기존 `meeting`/`view`/`activeId` 상태.
- Produces: `jumpToEvidence(meetingId, utteranceId)` — 뷰 전환·발언 하이라이트(seek 없음), 대상 발언이 현재 transcript에 없으면 토스트.

- [ ] **Step 1: topic을 meeting 도메인 LensKind에서 분리**

`src/features/meeting/model/types.ts`의 `LensKind`는 `"action" | "topic" | "decision" | "promise"`이고, 이를 소비하는 `Meeting.lenses`, `LensEntry`가 있다. topic은 아직 회의 상세 화면에서 쓰일 수 있으므로 **회의 도메인 타입은 건드리지 않는다.** 전역 대시보드는 Task 1의 자체 `LensKind`(3종)를 쓰므로 충돌이 없다. 이 스텝은 **확인만** 하고 변경 없음(회의 상세의 topic 사용처를 grep으로 점검):

Run: `grep -rn "topic" src/features/meeting src/pages/meeting.tsx`
회의 상세에서 topic 참조가 있으면 그대로 둔다. 대시보드 경로만 3종을 쓴다.

- [ ] **Step 2: Add `jumpToEvidence` to `meeting.tsx`**

`src/pages/meeting.tsx`에 seek 없는 점프와 historical 가드를 추가한다. `useToast`(`@/shared/ui/use-toast`)를 import한다.

```tsx
// 상단 훅 영역
const { toast } = useToast();

// openMeeting/jumpTo 근처에 추가
const jumpToEvidence = (mid: string, uid: string) => {
  openMeeting(mid);      // view=meeting, 회의 선택, seek/재생 리셋
  setActiveId(uid);      // 하이라이트/스크롤 대상 — pendingSeek 설정하지 않음(오디오 seek 없음)
};
```

historical 가드: 대상 회의가 로드된 뒤(`meeting.id === selectedId`) `activeId`가 현재 발언 목록에 없으면 안내 토스트. `activeId`가 원본 발화 id일 수 있으므로 `sources`까지 훑는다.

```tsx
React.useEffect(() => {
  if (!activeId || !meeting) return;
  const found = meeting.utterances.some(
    (u) => u.id === activeId || u.sources.some((s) => s.id === activeId),
  );
  if (!found) {
    toast({ description: "재처리로 근거 발언을 현재 버전에서 찾을 수 없어요." });
    setActiveId("");
  }
}, [activeId, meeting, toast]);
```

주의: 이 effect는 `jumpTo`(같은 회의 내 검색 점프)에도 걸린다. 그 경로는 이미 유효한 현재 발언만 넘기므로 `found`가 참이라 토스트가 뜨지 않는다. 확인용으로 `pages/meeting.test.tsx` 기존 검색 점프 테스트가 계속 통과하는지 본다.

- [ ] **Step 3: Swap `LensView` for `LensDashboard`**

`src/pages/meeting.tsx`에서 import 교체:

```tsx
// 제거: import { LensView } from "@/features/meeting/ui/lens-view";
import { LensDashboard } from "@/features/lens/ui/lens-dashboard";
```

렌더 교체(`view === "meeting" ? ... : (...)` 의 else 가지):

```tsx
) : (
  <LensDashboard
    lens={lens}
    onLens={setLens}
    onJumpEvidence={jumpToEvidence}
  />
)}
```

`done`/`toggleDone`/`onJump={openMeeting}`를 넘기던 기존 props는 제거한다(대시보드가 서버 완료 상태를 직접 다룸).

- [ ] **Step 4: Delete the placeholder**

```bash
git rm src/features/meeting/ui/lens-view.tsx
```

`lens-view.tsx`를 참조하는 다른 import가 없는지 확인:
Run: `grep -rn "lens-view" src`  → 결과 없어야 함.

- [ ] **Step 5: Add the jump test**

`src/pages/meeting.test.tsx`에 근거 점프가 회의뷰로 전환하고 대상 발언을 하이라이트하되 오디오 seek는 하지 않음을 검증하는 케이스를 추가한다(기존 파일의 렌더 헬퍼·MSW/모킹 방식을 따른다). historical 케이스: 존재하지 않는 utterance id로 점프 시 토스트 노출 + activeId 비워짐.

(기존 `meeting.test.tsx`의 셋업을 재사용하되, LensDashboard가 붙은 뒤 "모든 회의" 진입 → 항목의 "원문 보기" 클릭 경로를 시뮬레이트한다. 실제 셀렉터·모킹은 파일 컨벤션에 맞춘다.)

- [ ] **Step 6: Full verification**

Run:

```bash
pnpm vitest run
pnpm tsc -b --noEmit
pnpm build
```

Expected: 모두 통과. `grep -rn "lens-view" src` 결과 없음.

- [ ] **Step 7: Commit**

```bash
git add src/pages/meeting.tsx src/pages/meeting.test.tsx
git rm src/features/meeting/ui/lens-view.tsx
git commit -m "feat(lens): mount global dashboard and evidence jump in meeting shell"
```

## Plan Self-Review

- Spec coverage:
  - §3.1 배치·뷰 전환 → Task 6. topic 분리 → Task 1(meta 3종) + Task 6 Step 1(회의 도메인 불변 확인).
  - §5.1 모듈 구조 → Task 1·2·3·4·5 파일 생성.
  - §5.3 데이터 흐름(무한스크롤·상시폴링·낙관적 토글) → Task 1(hooks) + Task 2(list) + Task 5(조합).
  - §5.4 매핑(evidence primary, hint) → Task 2 `mapItemView`.
  - §5.5 근거 점프(seek 없음, historical 토스트) → Task 6 Step 2.
  - 필터 전부(완료·기간·화자·회의) → Task 3.
  - 추출 배너·재시도 → Task 4.
  - 빈·로딩·에러 → Task 5.
  - §7 FE 테스트(무한스크롤·토글·필터·배너·점프·historical·kind 3종) → Task 1·2·4·6 테스트.
- Placeholder scan: 코드 스텝마다 실제 코드 포함. Task 3/5/6의 UI 스텝은 실제 컴포넌트 코드를 담되, `DatePicker`/`Select`와 `meeting.test.tsx` 셀렉터는 "해당 파일 계약에 맞춰 어댑트"로 명시(실존 시그니처 확인 지시 포함) — 이는 미지정 placeholder가 아니라 로컬 계약 확인 지시.
- Type consistency: `LensFilters`/`LensListPage`/`LensWireItem`/`ExtractionStatus`가 Task 1에서 정의되고 이후 태스크에서 동일 이름으로 소비. `mapItemView` 반환형이 Task 2 안에서 일관. 훅 이름(`useLensList`,`useLensExtractionStatus`,`useSetLensCompletion`,`useRetryExtraction`)이 정의·소비처에서 일치.
- 알려진 확인 지점(구현 중 실물 시그니처 대조 필요): `DatePicker`(`src/shared/ui/date-picker.tsx`)·`Select`(`src/shared/ui/select.tsx`)의 value/onChange 계약, `meeting.test.tsx` 렌더/모킹 컨벤션.
