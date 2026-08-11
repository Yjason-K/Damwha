# 대화 요약 (프론트엔드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인사이트 패널의 요약 탭을 주요 주제 · 다음 할 일 · 핵심 결정 · 단락별 요약 네 블록으로 재구성하고, 지금 하드코딩된 빈 값을 실제 백엔드 데이터로 채운다.

**Architecture:** 요약(주제 + 단락)은 `GET /meetings/:id` 응답에 실려 오므로 기존 상세 매퍼가 처리한다. 회의별 렌즈(할 일 · 결정)는 별도 엔드포인트 `GET /meetings/:id/lenses`에서 오므로 독립 쿼리 훅으로 가져와 InsightPane에 프롭으로 넘긴다 — 이 비대칭은 API 모양을 그대로 따른 것이다. 단락별 요약은 320px 레일에 맞추기 위해 접힘이 기본이고, 행 클릭(펼침)과 시간 클릭(발언 점프)이 서로 다른 히트 영역이다.

**Tech Stack:** React 19 + Vite 8 + TypeScript strict + TanStack Query + Tailwind v4(CSS-first) + Radix/shadcn + Vitest(jsdom)

**설계 문서:** `../be/docs/superpowers/specs/2026-08-11-conversation-summary-design.md`

**선행 조건:** 백엔드 계획(`../be/docs/superpowers/plans/2026-08-11-conversation-summary-be.md`)의 Task 6까지 완료되어 `GET /meetings/:id`가 `summary` 필드를 반환해야 한다.

## Global Constraints

- **Node 22 + pnpm 필수** (`engine-strict=true`; npm/yarn은 실패한다). 새 셸이 Node 20으로 뜨는 경우가 잦으니 `node -v`가 다르면 명령마다 `nvm use 22 && pnpm ...`로 붙여 실행한다.
- **UI를 만들거나 고치기 전에 `DESIGN.md`를 읽는다.** 하드 금지: 라이트 전용 가정, 생 hex 값, 플랫 카드에 그림자, 임의 토큰 신설.
- 색은 시맨틱 별칭(`--surface-*`, `--text-*`, `--border-*`)으로 참조한다. 원시 스케일(`--gray-*` 등)을 컴포넌트에서 직접 쓰지 않는다.
- **TypeScript strict + `verbatimModuleSyntax`** — 타입 전용 import는 반드시 `import type { ... }`. `noUnusedLocals`/`noUnusedParameters`가 켜져 있다.
- **Prettier:** 큰따옴표, 세미콜론, trailing comma `all`, printWidth 80. 마무리 전에 `pnpm format`.
- UI 문구는 **한국어**.
- 로딩 상태는 `aria-busy` / `role="status"`로 전달한다 — 모션만으로 전달하지 않는다(`prefers-reduced-motion`은 `index.css`에서 전역 처리됨).
- `pnpm build`는 `tsc -b`(타입 검사)와 `vite build`를 따로 돌린다. **타입 오류의 기준은 `tsc -b`다** — Vite는 타입 검사를 하지 않는다.

---

### Task 1: 요약 와이어 타입과 상세 매핑

**Files:**
- Modify: `src/features/meeting/api/types.ts` (`WireMeetingDetail` `:75-78`, `MeetingStatusResponse` `:91-96`)
- Modify: `src/features/meeting/model/types.ts` (`Meeting` `:93-116`, `TopicChip` `:64`)
- Modify: `src/features/meeting/api/mappers.ts` (`:234-259` 반환 객체)
- Test: `src/features/meeting/api/mappers.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: 백엔드 `GET /meetings/:id` 응답의 `summary` 필드
- Produces:
  - `WireSummarySegment` = `{ start_utterance_id: string; end_utterance_id: string; start_ms: number; end_ms: number; title: string; bullets: string[] }`
  - `WireSummary` = `{ status: "queued" | "running" | "done" | "failed"; topics: string[]; segments: WireSummarySegment[] }`
  - `SummarySegmentView` = `{ id: string; startUtteranceId: string; t: string; title: string; bullets: string[] }` — `id`는 `start_utterance_id`, `t`는 `formatClock(start_ms)`
  - `Meeting.summary` 필드 **제거**, `Meeting.topics: string[]`로 타입 변경, `Meeting.segments: SummarySegmentView[]`와 `Meeting.summaryStatus: WireSummary["status"] | null` 추가
  - `Meeting.lenses` 필드 **제거** (Task 2에서 별도 프롭이 된다)

> `Meeting.summary: string[]`는 개요 불릿용 필드였는데 개요 블록을 만들지 않기로 했으므로 죽은 필드다. `TopicChip`(`{ label, spk }`)도 화자 색을 칠하려고 만든 형태인데, 주요 주제는 논의 주제라 화자가 없다 — 문자열 배열로 바뀐다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/features/meeting/api/mappers.test.ts`에 추가한다. `makeMeeting()`은 기존 파일의 헬퍼다.

```ts
describe("toMeetingDetail — 요약", () => {
  it("summary가 없으면 빈 주제/단락과 null 상태로 매핑한다", () => {
    const detail = toMeetingDetail({ ...makeMeeting(), utterances: [], clusters: [] });
    expect(detail.topics).toEqual([]);
    expect(detail.segments).toEqual([]);
    expect(detail.summaryStatus).toBeNull();
  });

  it("주제를 문자열 배열 그대로 옮긴다", () => {
    const detail = toMeetingDetail({
      ...makeMeeting(),
      utterances: [],
      clusters: [],
      summary: { status: "done", topics: ["파이프라인 실행 순서"], segments: [] },
    });
    expect(detail.topics).toEqual(["파이프라인 실행 순서"]);
    expect(detail.summaryStatus).toBe("done");
  });

  it("단락을 시각 표기와 함께 뷰 형태로 옮긴다", () => {
    const detail = toMeetingDetail({
      ...makeMeeting(),
      utterances: [],
      clusters: [],
      summary: {
        status: "done",
        topics: [],
        segments: [
          {
            start_utterance_id: "utt_1",
            end_utterance_id: "utt_9",
            start_ms: 67_000,
            end_ms: 130_000,
            title: "티켓 등록 수정",
            bullets: ["공유를 해드릴 것임"],
          },
        ],
      },
    });
    expect(detail.segments).toEqual([
      {
        id: "utt_1",
        startUtteranceId: "utt_1",
        t: "01:07",
        title: "티켓 등록 수정",
        bullets: ["공유를 해드릴 것임"],
      },
    ]);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm vitest run src/features/meeting/api/mappers.test.ts
```

Expected: FAIL — `detail.segments`가 `undefined`이고 `detail.topics`가 `TopicChip[]` 형태다.

- [ ] **Step 3: 와이어 타입을 추가한다**

`src/features/meeting/api/types.ts`에 추가한다.

```ts
export type SummaryStatus = "queued" | "running" | "done" | "failed";

/** GET /meetings/:id 응답의 요약 — 현재 processing_version이 아니면 서버가 null을 준다. */
export type WireSummarySegment = {
  start_utterance_id: string;
  end_utterance_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  bullets: string[];
};

export type WireSummary = {
  status: SummaryStatus;
  topics: string[];
  segments: WireSummarySegment[];
};
```

`WireMeetingDetail`을 확장한다.

```ts
export type WireMeetingDetail = WireMeeting & {
  utterances: WireUtterance[];
  clusters: WireCluster[];
  summary: WireSummary | null;
};
```

`MeetingStatusResponse`에 필드를 추가한다.

```ts
  summary_status: SummaryStatus | null;
```

- [ ] **Step 4: 도메인 타입과 매퍼를 고친다**

`src/features/meeting/model/types.ts`:

`TopicChip` 타입을 삭제하고 그 자리에 추가한다.

```ts
/** 단락별 요약 1개 — `t`는 시작 시각 표기, `id`는 점프 대상 발화 id. */
export type SummarySegmentView = {
  id: string;
  startUtteranceId: string;
  t: string;
  title: string;
  bullets: string[];
};
```

`Meeting`에서 `summary: string[];`와 `topics: TopicChip[];`와 `lenses: Partial<Record<LensKind, LensEntry[]>>;` 세 줄을 지우고 대신 넣는다.

```ts
  topics: string[];
  segments: SummarySegmentView[];
  summaryStatus: SummaryStatus | null;
```

`SummaryStatus`는 `../api/types`에서 `import type`으로 가져온다.

`src/features/meeting/api/mappers.ts`의 반환 객체(`:249`, `:252`, `:253`)를 고친다.

```ts
    topics: wire.summary?.topics ?? [],
    segments: (wire.summary?.segments ?? []).map((s) => ({
      id: s.start_utterance_id,
      startUtteranceId: s.start_utterance_id,
      t: formatClock(s.start_ms),
      title: s.title,
      bullets: s.bullets,
    })),
    summaryStatus: wire.summary?.status ?? null,
```

`summary: [],`와 `lenses: {},` 두 줄은 삭제한다.

- [ ] **Step 5: 통과를 확인한다**

```bash
pnpm vitest run src/features/meeting/api/mappers.test.ts
```

Expected: PASS. 이 시점에 `insight-pane.tsx`와 `meeting.tsx`는 아직 옛 필드를 참조하므로 `tsc -b`는 실패한다 — Task 3에서 해소된다.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/api/types.ts src/features/meeting/model/types.ts \
        src/features/meeting/api/mappers.ts src/features/meeting/api/mappers.test.ts
git commit -m "feat: 요약 와이어 타입과 상세 매핑 추가"
```

---

### Task 2: 회의별 렌즈 배선과 요약 재생성 훅

**Files:**
- Create: `src/features/meeting/api/lenses.ts`
- Modify: `src/features/meeting/api/mappers.ts` (새 export 함수 추가)
- Modify: `src/features/meeting/api/meetings.ts` (재생성 뮤테이션 + 상태 동기화 훅)
- Test: `src/features/meeting/api/mappers.test.ts` (렌즈 매핑 케이스 추가), `src/features/meeting/api/summary-sync.test.tsx` (신규)

**Interfaces:**
- Consumes: Task 1의 `Meeting.speakers`
- Produces:
  - `mapMeetingLenses(items: LensWireItem[], speakers: Record<number, SpeakerRef>): Partial<Record<LensKind, LensEntry[]>>` (from `mappers.ts`)
  - `useMeetingLenses(meetingId: string | undefined)` — `GET /meetings/:id/lenses` 무한스크롤 없는 단순 쿼리, queryKey `["meeting-lenses", meetingId]`
  - `useGenerateSummary()` — `POST /meetings/:id/summary/generate`, 성공 시 `["meeting", id]`와 `["meeting-status", id]` 무효화
  - `useSyncSummaryStatus(meetingId, detailStatus, polledStatus)` — 상태 폴링 결과가 상세 캐시와 어긋나면 상세를 1회 무효화한다

> **요약 완료를 감지하는 경로가 필요하다.** `useMeeting`(`meetings.ts:48-53`)은 회의 status가 `done`이면 폴링을 멈추고, `useMeetingStatus`는 `meeting.tsx:198-201`에서 회의가 처리 중일 때만 켜진다. 요약은 회의가 `done`이 된 **뒤에** 돌기 때문에, 손대지 않으면 `queued`를 한 번 받고 영영 로딩 상태에 갇힌다.
>
> 상세를 폴링하지 않는 이유: `GET /meetings/:id` 응답에는 발화 배열이 통째로 들어 있어 1시간짜리 대화면 매우 무겁다. 대신 가벼운 `GET /meetings/:id/status`를 폴링하고, 거기 실린 `summary_status`가 상세 캐시의 값과 달라진 순간에만 상세를 한 번 무효화한다. 무효화 후 상세가 다시 오면 두 값이 같아지므로 루프가 돌지 않는다.

> 백엔드 `GET /meetings/:id/lenses`(`lenses.controller.ts:17`)는 이미 있는데 FE가 호출한 적이 없다. 그래서 지금 인사이트 패널의 할 일·결정 블록은 요약과 똑같이 항상 비어 있다. 응답은 `{ items: LensWireItem[] }`이고 `LensWireItem`은 `src/features/lens/model/types.ts`에 이미 정의되어 있으므로 재사용한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/features/meeting/api/mappers.test.ts`에 추가한다.

```ts
import { mapMeetingLenses } from "./mappers";
import type { LensWireItem } from "@/features/lens/model/types";

const SPEAKERS = {
  1: { id: "spk_1", name: "김영재", role: "", spk: 1 },
  2: { id: "spk_2", name: "박민수", role: "", spk: 2 },
};

function wireItem(over: Partial<LensWireItem> = {}): LensWireItem {
  return {
    id: "lns_1",
    meeting_id: "mtg_1",
    kind: "action",
    text: "실행 로그 작성",
    source: "ai",
    assignee_speaker_id: null,
    due_at: null,
    evidence: [
      {
        relation: "primary",
        utterance: { id: "utt_1", start_ms: 0, text: "", speaker_name: null },
      },
    ],
    ...over,
  } as LensWireItem;
}

describe("mapMeetingLenses", () => {
  it("kind별로 묶는다", () => {
    const result = mapMeetingLenses(
      [wireItem(), wireItem({ id: "lns_2", kind: "decision", text: "v2로 한정" })],
      SPEAKERS,
    );
    expect(result.action?.map((i) => i.text)).toEqual(["실행 로그 작성"]);
    expect(result.decision?.map((i) => i.text)).toEqual(["v2로 한정"]);
  });

  it("담당 화자 id를 화자 틴트 번호로 바꾼다", () => {
    const result = mapMeetingLenses([wireItem({ assignee_speaker_id: "spk_2" })], SPEAKERS);
    expect(result.action?.[0].who).toBe(2);
  });

  it("모르는 담당 화자는 who를 비운다", () => {
    const result = mapMeetingLenses([wireItem({ assignee_speaker_id: "spk_99" })], SPEAKERS);
    expect(result.action?.[0].who).toBeUndefined();
  });

  it("primary 근거의 발화 id를 ev에 담는다", () => {
    const result = mapMeetingLenses([wireItem()], SPEAKERS);
    expect(result.action?.[0].ev).toBe("utt_1");
  });

  it("근거가 사라진 AI 항목은 source를 hint로 낮춘다", () => {
    const result = mapMeetingLenses([wireItem({ evidence: [] })], SPEAKERS);
    expect(result.action?.[0].source).toBe("hint");
    expect(result.action?.[0].ev).toBe("");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm vitest run src/features/meeting/api/mappers.test.ts
```

Expected: FAIL — `mapMeetingLenses`가 export되지 않았다.

- [ ] **Step 3: 매핑 함수를 구현한다**

`src/features/meeting/api/mappers.ts` 맨 아래에 추가한다.

```ts
/**
 * 회의별 렌즈 항목(GET /meetings/:id/lenses)을 인사이트 패널이 쓰는 형태로 바꾼다.
 * 담당 화자는 서버가 speaker id로 주고 UI는 틴트 번호(spk)를 쓰므로 여기서 역인덱싱한다.
 * 근거가 사라진 AI 항목은 전역 대시보드와 같은 규칙으로 "확인 필요"(hint)로 낮춘다.
 */
export function mapMeetingLenses(
  items: LensWireItem[],
  speakers: Record<number, SpeakerRef>,
): Partial<Record<LensKind, LensEntry[]>> {
  const spkBySpeakerId = new Map<string, number>();
  for (const ref of Object.values(speakers)) {
    if (ref.id) spkBySpeakerId.set(ref.id, ref.spk);
  }

  const grouped: Partial<Record<LensKind, LensEntry[]>> = {};
  for (const item of items) {
    const primary =
      item.evidence.find((e) => e.relation === "primary") ?? null;
    const who = item.assignee_speaker_id
      ? spkBySpeakerId.get(item.assignee_speaker_id)
      : undefined;
    const entry: LensEntry = {
      id: item.id,
      text: item.text,
      source: item.source === "ai" && !primary ? "hint" : item.source,
      who,
      ev: primary?.utterance.id ?? "",
      due: item.due_at ?? undefined,
    };
    (grouped[item.kind] ??= []).push(entry);
  }
  return grouped;
}
```

필요한 `import type`을 파일 상단에 추가한다 — `LensWireItem`은 `@/features/lens/model/types`에서, `LensEntry`·`LensKind`·`SpeakerRef`는 `../model/types`에서 가져온다.

- [ ] **Step 4: 쿼리 훅을 만든다**

`src/features/meeting/api/lenses.ts`:

```ts
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { LensWireItem } from "@/features/lens/model/types";

/** 회의 1건의 활성 렌즈 항목 (GET /meetings/:id/lenses). */
export function useMeetingLenses(
  meetingId: string | undefined,
): UseQueryResult<LensWireItem[]> {
  return useQuery({
    queryKey: ["meeting-lenses", meetingId],
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: LensWireItem[] }>(
        `/meetings/${meetingId}/lenses`,
      );
      return data.items;
    },
    enabled: !!meetingId,
  });
}
```

`src/features/meeting/api/meetings.ts` 맨 아래에 추가한다.

```ts
/** 대화 요약 생성/재생성 (POST /meetings/:id/summary/generate). done에서만 허용(그 외 409). */
export function useGenerateSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string }) => {
      const { data } = await apiClient.post<{
        status: string;
        job_id: string | null;
        processing_version: number;
      }>(`/meetings/${vars.id}/summary/generate`);
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
      queryClient.invalidateQueries({ queryKey: ["meeting-status", vars.id] });
    },
  });
}

/**
 * 요약 상태 동기화 — 상세 응답은 회의가 done이면 더 폴링되지 않는데, 요약 잡은
 * 그 뒤에 돈다. 가벼운 상태 엔드포인트가 알려준 summary_status가 상세 캐시의
 * 값과 어긋나면 상세를 한 번만 다시 가져온다. 갱신 후 두 값이 같아지므로
 * 반복 무효화로 이어지지 않는다.
 */
export function useSyncSummaryStatus(
  meetingId: string | undefined,
  detailStatus: SummaryStatus | null | undefined,
  polledStatus: SummaryStatus | null | undefined,
) {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!meetingId || polledStatus === undefined) return;
    if (polledStatus === detailStatus) return;
    queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
  }, [meetingId, detailStatus, polledStatus, queryClient]);
}
```

`React`와 `SummaryStatus` 타입 import를 파일 상단에 추가한다.

- [ ] **Step 5: 상태 동기화 훅 테스트를 쓴다**

`src/features/meeting/api/summary-sync.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { useSyncSummaryStatus } from "./meetings";

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}

describe("useSyncSummaryStatus", () => {
  it("상태가 같으면 아무것도 하지 않는다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", "running", "running"), {
      wrapper,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("폴링이 아직 값을 못 받았으면 아무것도 하지 않는다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", "running", undefined), {
      wrapper,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("queued에서 done으로 바뀌면 상세를 무효화한다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", "queued", "done"), {
      wrapper,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meeting", "mtg_1"] });
  });

  it("요약이 없다가 생기면(null → queued) 상세를 무효화한다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", null, "queued"), { wrapper });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meeting", "mtg_1"] });
  });

  it("회의 id가 없으면 아무것도 하지 않는다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus(undefined, null, "done"), { wrapper });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 통과를 확인한다**

```bash
pnpm vitest run src/features/meeting/api/mappers.test.ts \
                src/features/meeting/api/summary-sync.test.tsx
```

Expected: PASS (mappers 5건 + sync 5건)

- [ ] **Step 7: 커밋**

```bash
git add src/features/meeting/api/lenses.ts src/features/meeting/api/mappers.ts \
        src/features/meeting/api/meetings.ts src/features/meeting/api/mappers.test.ts \
        src/features/meeting/api/summary-sync.test.tsx
git commit -m "feat: 회의별 렌즈 조회·요약 재생성·요약 상태 동기화 훅 추가"
```

---

### Task 3: 인사이트 패널 재구성

**Files:**
- Modify: `src/features/meeting/ui/insight-pane.tsx` (전면 재구성)
- Modify: `src/pages/meeting.tsx` (`:275-280` `openLens`, `:451-458` InsightPane 호출, 요약 재생성 배선)
- Test: `src/features/meeting/ui/insight-pane.test.tsx` (신규)

**Interfaces:**
- Consumes: Task 1의 `Meeting.topics` / `Meeting.segments` / `Meeting.summaryStatus`, Task 2의 `mapMeetingLenses` · `useMeetingLenses` · `useGenerateSummary`
- Produces: `InsightPane` 프롭이 다음으로 바뀐다.

```ts
type InsightPaneProps = {
  meeting: Meeting;
  lenses: Partial<Record<LensKind, LensEntry[]>>;
  tab: string;
  onTab: (tab: string) => void;
  done: Record<string, boolean>;
  onToggle: (id: string) => void;
  onOpenLens: (lens: LensKind) => void;
  onJumpSegment: (utteranceId: string) => void;
  onRegenerateSummary: () => void;
  regenerating: boolean;
};
```

**바뀌는 것 요약**

- 탭이 `요약 / 참석자 / 파일 / 메모` → **`요약 / 파일 / 메모`**. 참석자 블록은 요약 탭 최상단에 그대로 남으므로 별도 탭이 중복이었다. `:382`의 `onMore={() => onTab("people")}`("모두 보기")는 갈 곳이 없어져 제거한다.
- 요약 탭 블록 순서: **참석자 → 주요 주제 → 다음 할 일 → 핵심 결정 → 단락별 요약**.
- `Topics` 컴포넌트가 태그 클라우드에서 **불릿 목록**으로 바뀐다 (`<Tag speaker={t.spk}>` 제거 — 주제에는 화자가 없다).
- 요약 탭 헤더에 **재생성 버튼 하나**. 서버가 주제와 단락을 한 번의 LLM 호출로 만들기 때문에 블록 단위 재생성은 존재할 수 없다.
- `Summary`(개요 불릿) 컴포넌트는 삭제한다.

**토큰 주의.** 지금 요약 불릿 점은 `insight-pane.tsx:147`에서 원시 스케일 `--accent-9`를 직접 쓴다. 새로 쓰는 코드는 같은 값으로 해석되는 시맨틱 별칭을 쓴다 — `index.css:102` `--accent-solid: var(--accent-9)`, `:93` `--text-faint: var(--gray-7)`. 렌더 결과는 동일하고 프로젝트 규칙(원시 스케일 직접 참조 금지)만 지켜진다. `:147`의 기존 위반은 삭제되는 `Summary` 컴포넌트 안이라 함께 사라지며, 그 밖의 선재하는 원시 스케일 사용(`:372`의 `--gray-3` 등)은 **건드리지 않는다** — 이번 요청과 무관한 수정이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/features/meeting/ui/insight-pane.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InsightPane } from "./insight-pane";
import type { LensEntry, LensKind, Meeting } from "../model/types";

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

const NO_LENSES: Partial<Record<LensKind, LensEntry[]>> = {};

function renderPane(props: Partial<React.ComponentProps<typeof InsightPane>> = {}) {
  const merged = {
    meeting: meeting(),
    lenses: NO_LENSES,
    tab: "summary",
    onTab: vi.fn(),
    done: {},
    onToggle: vi.fn(),
    onOpenLens: vi.fn(),
    onJumpSegment: vi.fn(),
    onRegenerateSummary: vi.fn(),
    regenerating: false,
    ...props,
  };
  render(<InsightPane {...merged} />);
  return merged;
}

describe("InsightPane", () => {
  it("탭은 요약·파일·메모 세 개다", () => {
    renderPane();
    expect(screen.getByRole("tab", { name: "요약" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "참석자" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /파일/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "메모" })).toBeInTheDocument();
  });

  it("주요 주제를 불릿 목록으로 보여준다", () => {
    renderPane({ meeting: meeting({ topics: ["파이프라인 실행 순서", "예약 관리"] }) });
    expect(screen.getByText("파이프라인 실행 순서")).toBeInTheDocument();
    expect(screen.getByText("예약 관리")).toBeInTheDocument();
  });

  it("결과가 없는 핵심 결정 블록은 렌더하지 않는다", () => {
    renderPane();
    expect(screen.queryByText("핵심 결정")).not.toBeInTheDocument();
  });

  it("렌즈가 있으면 할 일과 결정 블록을 채운다", () => {
    renderPane({
      lenses: {
        action: [{ id: "l1", text: "실행 로그 작성", source: "ai", ev: "utt_1" }],
        decision: [{ id: "l2", text: "v2로 한정", source: "ai", ev: "utt_2" }],
      },
    });
    expect(screen.getByText("실행 로그 작성")).toBeInTheDocument();
    expect(screen.getByText("v2로 한정")).toBeInTheDocument();
  });

  it("단락은 접힌 채로 시작하고 행을 누르면 불릿이 펼쳐진다", async () => {
    const user = userEvent.setup();
    renderPane({
      meeting: meeting({
        segments: [
          {
            id: "utt_1",
            startUtteranceId: "utt_1",
            t: "01:07",
            title: "티켓 등록 수정",
            bullets: ["공유를 해드릴 것임"],
          },
        ],
      }),
    });
    expect(screen.queryByText("공유를 해드릴 것임")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /티켓 등록 수정/ }));
    expect(screen.getByText("공유를 해드릴 것임")).toBeInTheDocument();
  });

  it("단락의 시각을 누르면 펼치지 않고 점프한다", async () => {
    const user = userEvent.setup();
    const props = renderPane({
      meeting: meeting({
        segments: [
          {
            id: "utt_1",
            startUtteranceId: "utt_1",
            t: "01:07",
            title: "티켓 등록 수정",
            bullets: ["공유를 해드릴 것임"],
          },
        ],
      }),
    });
    await user.click(screen.getByRole("button", { name: "01:07로 이동" }));
    expect(props.onJumpSegment).toHaveBeenCalledWith("utt_1");
    expect(screen.queryByText("공유를 해드릴 것임")).not.toBeInTheDocument();
  });

  it("요약 생성 중이면 진행 상태를 알린다", () => {
    renderPane({ meeting: meeting({ summaryStatus: "running", topics: [], segments: [] }) });
    const status = screen.getByRole("status");
    expect(within(status).getByText("요약을 만들고 있어요")).toBeInTheDocument();
  });

  it("요약이 실패하면 재생성 버튼을 누를 수 있다", async () => {
    const user = userEvent.setup();
    const props = renderPane({ meeting: meeting({ summaryStatus: "failed" }) });
    await user.click(screen.getByRole("button", { name: "요약 다시 만들기" }));
    expect(props.onRegenerateSummary).toHaveBeenCalled();
  });

  it("요약이 한 번도 없던 회의는 만들기 버튼을 준다", async () => {
    const user = userEvent.setup();
    const props = renderPane({ meeting: meeting({ summaryStatus: null }) });
    await user.click(screen.getByRole("button", { name: "요약 만들기" }));
    expect(props.onRegenerateSummary).toHaveBeenCalled();
  });

  it("요약 생성 중에는 할 일 블록이 그대로 남는다", () => {
    renderPane({
      meeting: meeting({ summaryStatus: "running" }),
      lenses: {
        action: [{ id: "l1", text: "실행 로그 작성", source: "ai", ev: "utt_1" }],
      },
    });
    expect(screen.getByText("실행 로그 작성")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm vitest run src/features/meeting/ui/insight-pane.test.tsx
```

Expected: FAIL — `InsightPane`이 `lenses` / `onJumpSegment` / `onRegenerateSummary` 프롭을 모르고, 참석자 탭이 아직 있다.

- [ ] **Step 3: InsightPane을 재구성한다**

`src/features/meeting/ui/insight-pane.tsx`에서 다음을 수행한다.

1. `Summary` 컴포넌트(`:130-155`)를 삭제한다.
2. `Attendees`의 `onMore` 프롭과 `:382`의 `onMore={() => onTab("people")}`를 제거한다.
3. `TabsList`(`:366-378`)에서 `<TabsTrigger value="people">참석자</TabsTrigger>`와 `<TabsContent value="people">` 블록(`:391-393`)을 삭제한다.
4. `Topics`(`:257-276`)를 불릿 목록으로 바꾸고 이름을 `TopicList`로 바꾼다. `Tag` import가 이 파일에서 더 쓰이지 않으면 함께 제거한다.

```tsx
function TopicList({ topics }: { topics: string[] }) {
  return (
    <Section>
      <SecHead title="주요 주제" count={topics.length} />
      {topics.length === 0 ? (
        <p className="text-sm text-[color:var(--text-faint)]">
          추출된 주제가 없어요.
        </p>
      ) : (
        <ul className="flex flex-col gap-[9px]">
          {topics.map((t) => (
            <li
              key={t}
              className="flex gap-[9px] text-sm leading-normal text-[color:var(--text-secondary)]"
            >
              <span
                aria-hidden="true"
                className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--accent-solid)]"
              />
              <span className="text-pretty">{t}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
```

5. `Decisions`(`:157-186`)와 `Todos`(`:188-255`)가 `meeting.lenses` 대신 새 `lenses` 프롭을 읽도록 바꾼다. 본문 로직은 그대로 두고 `const items = lenses.decision ?? []` / `const items = lenses.action ?? []`로만 고친다.

6. 단락 컴포넌트를 새로 만든다. 행 전체가 펼침 버튼이고, 시각은 그 안에 중첩되지 않는 **형제 버튼**이어야 한다 — 중첩 버튼은 유효하지 않은 HTML이고 클릭이 양쪽에 모두 전달된다.

```tsx
function SummarySegments({
  segments,
  onJump,
}: {
  segments: SummarySegmentView[];
  onJump: (utteranceId: string) => void;
}) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  if (segments.length === 0) return null;
  return (
    <Section last>
      <SecHead title="단락별 요약" count={segments.length} />
      <ul className="flex flex-col">
        {segments.map((s) => {
          const expanded = !!open[s.id];
          return (
            <li key={s.id} className="flex flex-col">
              <div className="flex items-start gap-[7px]">
                <button
                  type="button"
                  aria-label={`${s.t}로 이동`}
                  onClick={() => onJump(s.startUtteranceId)}
                  className="mt-px shrink-0 cursor-pointer rounded-xs font-mono text-2xs text-[color:var(--text-link)] outline-none hover:underline focus-visible:[box-shadow:var(--focus-ring)]"
                >
                  {s.t}
                </button>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
                  className="min-w-0 flex-1 cursor-pointer rounded-xs py-1 text-left text-sm leading-snug text-pretty text-foreground outline-none hover:bg-[var(--surface-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
                >
                  {s.title}
                </button>
              </div>
              {expanded && (
                <ul className="mt-[5px] mb-[9px] ml-[46px] flex flex-col gap-[7px]">
                  {s.bullets.map((b, i) => (
                    <li
                      key={i}
                      className="flex gap-[9px] text-sm leading-normal text-[color:var(--text-secondary)]"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--text-faint)]"
                      />
                      <span className="text-pretty">{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
```

7. 요약 상태 블록을 만든다.

```tsx
function SummaryState({
  status,
  onRegenerate,
  regenerating,
}: {
  status: Meeting["summaryStatus"];
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  if (status === "queued" || status === "running" || regenerating) {
    return (
      <Section>
        <div role="status" aria-busy="true">
          <p className="text-sm text-[color:var(--text-muted)]">
            요약을 만들고 있어요
          </p>
        </div>
      </Section>
    );
  }
  if (status === "failed") {
    return (
      <Section>
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm text-[color:var(--text-muted)]">
            요약을 만들지 못했어요.
          </p>
          <button
            type="button"
            onClick={onRegenerate}
            className="cursor-pointer rounded-xs text-xs font-medium text-[color:var(--text-link)] outline-none hover:underline focus-visible:[box-shadow:var(--focus-ring)]"
          >
            요약 다시 만들기
          </button>
        </div>
      </Section>
    );
  }
  // status === null — 요약이 한 번도 만들어지지 않은 회의(워커에 요약 모델이
  // 설정되지 않았거나 이 회의가 그 전에 처리됨). 빈 화면 대신 만들 길을 준다.
  return (
    <Section>
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-[color:var(--text-faint)]">
          아직 요약이 없어요.
        </p>
        <button
          type="button"
          onClick={onRegenerate}
          className="cursor-pointer rounded-xs text-xs font-medium text-[color:var(--text-link)] outline-none hover:underline focus-visible:[box-shadow:var(--focus-ring)]"
        >
          요약 만들기
        </button>
      </div>
    </Section>
  );
}
```

8. 요약 탭 본문을 조립한다. 상태가 `queued`/`running`/`failed`면 `SummaryState`만 보여주고 주제·단락 블록은 감춘다(빈 블록 두 개를 나란히 두면 무슨 일이 일어나는지 알 수 없다). 할 일·결정은 별도 잡이라 요약 상태와 무관하게 항상 렌더한다.

```tsx
<TabsContent value="summary" className="mt-0">
  <Attendees meeting={meeting} />
  {settled ? (
    <TopicList topics={meeting.topics} />
  ) : (
    <SummaryState
      status={meeting.summaryStatus}
      onRegenerate={onRegenerateSummary}
      regenerating={regenerating}
    />
  )}
  <Todos lenses={lenses} meeting={meeting} done={done} onToggle={onToggle} />
  <Decisions lenses={lenses} onMore={() => onOpenLens("decision")} />
  {settled && (
    <SummarySegments segments={meeting.segments} onJump={onJumpSegment} />
  )}
</TabsContent>
```

`settled`는 `meeting.summaryStatus === "done" && !regenerating`으로 계산한다.

9. 요약 탭 헤더에 재생성 버튼을 단다. `TabsList`가 있는 헤더 줄의 오른쪽 끝에 두고, `tab === "summary"`이고 `settled`일 때만 렌더한다.

```tsx
{tab === "summary" && settled && (
  <button
    type="button"
    aria-label="요약 다시 만들기"
    onClick={onRegenerateSummary}
    className="ml-auto cursor-pointer rounded-xs p-1 text-[color:var(--text-muted)] outline-none hover:bg-[var(--surface-hover)] hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]"
  >
    <Icon name="rotateCcw" size={14} />
  </button>
)}
```

`rotateCcw` 아이콘은 `TranscriptPane`의 재처리 버튼이 이미 쓰는 이름이다 — `icons.tsx`에 있다.

- [ ] **Step 4: 페이지를 배선한다**

`src/pages/meeting.tsx`:

임포트를 추가한다.

```ts
import { useMeetingLenses } from "@/features/meeting/api/lenses";
import { useGenerateSummary } from "@/features/meeting/api/meetings";
import { mapMeetingLenses } from "@/features/meeting/api/mappers";
```

`useMeeting` 호출 아래에 추가한다.

```ts
const { data: lensItems = [] } = useMeetingLenses(currentId);
const generateSummary = useGenerateSummary();
const meetingLenses = React.useMemo(
  () => (meeting ? mapMeetingLenses(lensItems, meeting.speakers) : {}),
  [lensItems, meeting],
);
```

`statusEnabled`(`:198-201`)를 요약이 도는 동안에도 켜지도록 넓힌다. 회의는 `done`인데 요약 잡이 그 뒤에 돌기 때문에, 이 조건을 넓히지 않으면 상태 폴링이 아예 안 붙는다.

```ts
const summaryPending =
  meeting?.summaryStatus === "queued" ||
  meeting?.summaryStatus === "running" ||
  generateSummary.isPending;

const statusEnabled =
  !!meeting &&
  (meeting.status === "uploaded" ||
    meeting.status === "processing" ||
    summaryPending);
const { data: procStatus } = useMeetingStatus(currentId, statusEnabled);

useSyncSummaryStatus(currentId, meeting?.summaryStatus, procStatus?.summary_status);
```

`useSyncSummaryStatus`를 `@/features/meeting/api/meetings`에서 함께 import 한다.

`openLens`(`:275-280`)의 `if (k !== "topic")` 가드를 제거한다 — `LensKind`에서 `topic`이 사라졌으므로 불필요해진다. `src/features/meeting/model/types.ts`의 `LensKind`도 `"action" | "decision" | "promise"`로 좁힌다.

`InsightPane` 호출(`:451-458`)에 새 프롭을 넘긴다.

```tsx
<InsightPane
  meeting={meeting}
  lenses={meetingLenses}
  tab={tab}
  onTab={setTab}
  done={done}
  onToggle={toggleDone}
  onOpenLens={openLens}
  onJumpSegment={(uid) => jumpToEvidence(meeting.id, uid)}
  onRegenerateSummary={() => generateSummary.mutate({ id: meeting.id })}
  regenerating={generateSummary.isPending}
/>
```

**`jumpTo`가 아니라 `jumpToEvidence`(`:284-287`)를 쓴다.** 단락 점프는 렌즈 근거 점프와 같은 규칙이다 — 뷰 전환 + 발언 하이라이트만 하고 **오디오 seek은 하지 않는다**(설계 §7.3). `jumpTo`는 오디오를 함께 이동시키므로 여기에 맞지 않는다. 이 경로를 쓰면 재처리로 발화가 사라진 경우의 안내 토스트(`:297-309`의 historical 가드)도 그대로 적용된다.

- [ ] **Step 5: 통과를 확인한다**

```bash
pnpm vitest run src/features/meeting/ui/insight-pane.test.tsx
pnpm test
pnpm build
```

Expected: 새 스위트 PASS (11 passed), 전체 스위트 PASS, `tsc -b` 타입 오류 없음.

- [ ] **Step 6: 포맷·린트**

```bash
pnpm format && pnpm lint
```

Expected: 변경 없음 / 오류 없음

- [ ] **Step 7: 커밋**

```bash
git add src/features/meeting/ui/insight-pane.tsx \
        src/features/meeting/ui/insight-pane.test.tsx \
        src/features/meeting/model/types.ts src/pages/meeting.tsx
git commit -m "feat: 요약 탭을 주제·할 일·결정·단락 네 블록으로 재구성"
```

---

### Task 4: 문서 갱신 — 대화 중심 재작성

**Files:**
- Modify: `docs/product-concept.md`
- Modify: `CLAUDE.md` ("Product concept" 절)

**Interfaces:**
- Consumes: Task 1–3 전체
- Produces: 없음 (문서)

- [ ] **Step 1: 개념 정의서를 대화 중심으로 고친다**

`docs/product-concept.md`에서 다음을 바꾼다.

- 제목과 1장 — "회의 기록·검색 플랫폼"을 **대화 기록·검색 플랫폼**으로. 녹음 대상은 회의일 수도, 인터뷰나 통화, 그냥 대화일 수도 있다. 서비스명 담화(Damwha)가 원래 그 뜻이고, 파이프라인 어디에도 회의 전제가 없다.
- 3장 목표 2번 "정리" — 요약(주요 주제 · 단락별 요약)이 기반층이고, 유형별 추출(렌즈)이 그 위 확장층임을 명시한다.
- 5.5 렌즈 절 — "필요할 때 켜는 보조 뷰"라는 서술을 **"대화가 회의 성격일 때만 결과가 나오는 확장층"**으로 바꾼다. 대화 유형 필드는 도입하지 않으며, 잡담 녹음은 추출 결과가 0건이라 섹션이 자동으로 사라진다는 점을 적는다.
- 5장에 **5.6 대화 요약** 절을 새로 넣는다: 주요 주제 · 단락별 요약을 로컬 LLM 1회 호출로 뽑고, 읽기 전용이며 통째 재생성만 제공하고, 단락의 시각은 LLM이 아니라 DB의 발화 행에서 파생된다는 것.
- 6장 화면 구조 — 우측 인사이트 패널 탭이 `요약 / 파일 / 메모`이고 요약 탭이 참석자 · 주요 주제 · 다음 할 일 · 핵심 결정 · 단락별 요약 순으로 쌓인다는 것으로 갱신한다.
- 7장 파이프라인 — 5번 "구조화 / 인덱싱" 뒤에 요약 단계를 추가하고, 코드 블록의 흐름도에도 반영한다.
- 8장 결정됨 — 설계 문서 9장의 결정 8건(대화 유형 없음, 블록 구성, 배치, 단락 접힘, 추출 구조 분리, 읽기 전용, 용어 범위, 참석자 탭 삭제)을 근거와 함께 옮긴다.

- [ ] **Step 2: CLAUDE.md의 제품 개념 절을 맞춘다**

`CLAUDE.md`의 "Product concept" 절에서 다음을 반영한다.

- 첫 줄의 "meeting recording + search platform"을 conversation 중심 서술로 바꾸되, **코드·DB·API의 `meeting` 용어는 그대로임을 명시한다** (의도적 결정 — UI 카피와 문서만 대화 중심).
- "Three jobs" 목록의 정리(정리) 항목에 요약이 기반층이라는 점을 넣는다.
- Lenses 불릿을 확장층 서술로 바꾸고, `LensKind`가 `action | decision | promise` 세 종류라는 것(FE `topic` 제거)을 적는다.
- `features/meeting` 설명에 요약 매핑과 `useMeetingLenses`를 추가한다.

- [ ] **Step 3: 커밋**

```bash
git add docs/product-concept.md CLAUDE.md
git commit -m "docs: 개념 정의서를 대화 중심으로 재작성"
```

---

## 완료 확인

```bash
pnpm test     # Vitest 전체
pnpm build    # tsc -b 타입 검사 + vite build
pnpm lint
pnpm format
```

네 명령이 모두 통과하고, `pnpm dev`로 띄운 `/app`에서 처리가 끝난 대화의 요약 탭에 주요 주제 · 다음 할 일 · 핵심 결정 · 단락별 요약이 실제 데이터로 채워지면 완료다.
