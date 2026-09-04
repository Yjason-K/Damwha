# 공개 데모 둘러보기(투어) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공개 데모에 driver.js 기반 10단계 둘러보기와, 워커 없이 브라우저 타이머로 재생되는
가짜 업로드 파이프라인을 붙인다. 결과 회의는 미리 시드된 `mtg_7`을 숨겼다가 드러낸다.

**Architecture:** 전부 `fe/` 안. (1) `features/demo/model/`의 localStorage 상태와 시뮬레이션
상태 머신, (2) 그 둘을 읽어 응답을 가공하는 axios 응답 인터셉터, (3) driver.js를 감싼
러너·단계 정의, (4) 입구(첫 방문 모달·네비 버튼)와 종료 확인(ESC·라우트 이동 가드) UI.
서버·워커 변경 없음.

**Tech Stack:** React 19, Vite 8, TanStack Query 5, react-router 7 (`useBlocker`), axios,
driver.js 1.8, vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-04-demo-guided-tour-design.md`

## Global Constraints

- 작업 디렉터리는 `fe/`. 모든 명령은 `cd fe && pnpm …` 또는 루트에서 `pnpm fe …`. Node 22
  (`nvm use 22`).
- `npm install` 금지. 의존성 추가는 `cd fe && pnpm add driver.js@1.8.0`.
- 데모 빌드 플래그는 `env.demoMode`(`VITE_DEMO_MODE=true`)만 본다. `import.meta.env`는
  `shared/config/env.ts`를 통해서만 읽는다.
- 비데모 빌드에 투어 UI 컴포넌트가 로드되면 안 된다 — React 컴포넌트는 `lazy()`. 모델·인터셉터
  모듈(React 없음, 수 KB)은 정적 import 허용.
- 서버 응답을 위조하는 범위는 스펙 §4.2·§4.3 표에 적힌 것뿐. 404 위조 없음.
- 사용자 대면 문구는 합쇼체("~해요"가 아니라 "~합니다")가 아니라 **기존 UI와 같은 해요체**.
  기존 데모 모달만 합쇼체였고(커밋 `9234d76`), 이번에 투어 문구와 함께 해요체로 맞춘다.
- 투어 회의 상수(시드 확정): `meeting_id = "mtg_7"`, `file_label = "AI가_내_머릿속_미지를_사냥하게_하라.m4a · 42.0 MB"`,
  `search_query = "프롬프트"`. 코드에는 박지 않고 env로 주입한다(§6).
- 커밋 메시지는 기존 규칙: `type(scope): 한국어 서술문` + 끝에
  `Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW`.

---

## 파일 구조

| 경로 | 책임 |
|---|---|
| `fe/src/shared/config/env.ts` | `demoTour` 설정 노출 |
| `fe/src/vite-env.d.ts` | 새 env 키 타입 |
| `fe/src/features/demo/model/tour-state.ts` | localStorage `{uploaded, noticeSeen}` + 구독 |
| `fe/src/features/demo/model/upload-simulation.ts` | 12초 stage 상태 머신 + 쿼리 invalidate |
| `fe/src/features/demo/api/demo-tour-interceptor.ts` | 응답 가공(숨김·덮어쓰기) |
| `fe/src/features/demo/lib/wait-for.ts` | 셀렉터 출현 대기 |
| `fe/src/features/demo/lib/tour-steps.ts` | 단계 정의(타깃·문구·prepare) |
| `fe/src/features/demo/lib/tour-runner.ts` | driver.js 래퍼, 시작/종료/종료요청 이벤트 |
| `fe/src/features/demo/ui/demo-upload-source.tsx` | 업로드 모달의 테스트 오디오 행 |
| `fe/src/features/demo/ui/tour-exit-dialog.tsx` | 종료 확인 모달(표시 전용) |
| `fe/src/features/demo/ui/tour-navigation-guard.tsx` | `useBlocker` + 종료요청 구독 → 모달 |
| `fe/src/features/demo/ui/tour-launch-button.tsx` | 네비 하단 "둘러보기" |
| `fe/src/features/demo/ui/demo-notice-dialog.tsx` | 첫 방문 모달 개편 |
| `fe/src/features/demo/tour.css` | driver 팝오버 토큰 스타일 |
| `fe/src/features/meeting/ui/upload-dialog.tsx` | 데모 분기 |
| `fe/src/features/meeting/ui/left-nav.tsx` | `data-tour` + 둘러보기 버튼 |
| `fe/src/features/meeting/ui/insight-pane.tsx` · `transcript-pane.tsx` · `player-bar.tsx` · `pages/meeting.tsx` · `shared/ui/command-bar.tsx` | `data-tour` 속성 |
| `fe/src/app/providers.tsx` · `app/app-shell.tsx` | 인터셉터 설치, 가드 렌더 |
| `deploy/api.Dockerfile` · `deploy/demo/release.sh` · `deploy/demo/README.md` · `demo/seed/tour.json` · `fe/.env.example` | 빌드 주입 |

---

### Task 1: env 설정과 투어 상태 저장소

**Files:**
- Modify: `fe/src/shared/config/env.ts`
- Modify: `fe/src/vite-env.d.ts`
- Create: `fe/src/features/demo/model/tour-state.ts`
- Test: `fe/src/features/demo/model/tour-state.test.ts`

**Interfaces:**
- Produces: `env.demoTour: { meetingId: string; fileLabel: string; searchQuery: string } | null`
- Produces: `TOUR_STORAGE_KEY`, `type TourState = { uploaded: boolean; noticeSeen: boolean }`,
  `readTourState(): TourState`, `writeTourState(patch: Partial<TourState>): void`,
  `subscribeTourState(cb: (s: TourState) => void): () => void`

- [ ] **Step 1: env 타입과 설정 추가**

`fe/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DEMO_MODE?: string;
  /** 데모 투어가 "업로드 결과"로 드러낼 시드 회의 id. 비면 투어의 업로드 단계가 빠진다. */
  readonly VITE_DEMO_TOUR_MEETING_ID?: string;
  /** 업로드 모달에 보일 테스트 오디오 라벨("파일명 · 42.0 MB"). */
  readonly VITE_DEMO_TOUR_FILE_LABEL?: string;
  /** 검색 단계에서 팔레트에 넣을 예시 검색어. */
  readonly VITE_DEMO_TOUR_SEARCH_QUERY?: string;
}
```

`fe/src/shared/config/env.ts`:

```ts
const tourMeetingId = import.meta.env.VITE_DEMO_TOUR_MEETING_ID?.trim();

export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api",
  /** 공개 데모 빌드. 읽기 전용 인터셉터와 첫 방문 안내 모달을 켠다(설계 §3.6). */
  demoMode: import.meta.env.VITE_DEMO_MODE === "true",
  /**
   * 데모 둘러보기의 가짜 업로드 설정(투어 설계 §6). 데모 빌드가 아니거나 회의 id가
   * 없으면 null — 그러면 투어는 업로드 단계를 빼고 돈다.
   */
  demoTour:
    import.meta.env.VITE_DEMO_MODE === "true" && tourMeetingId
      ? {
          meetingId: tourMeetingId,
          fileLabel: import.meta.env.VITE_DEMO_TOUR_FILE_LABEL?.trim() || "테스트 오디오",
          searchQuery: import.meta.env.VITE_DEMO_TOUR_SEARCH_QUERY?.trim() ?? "",
        }
      : null,
} as const;
```

- [ ] **Step 2: tour-state 실패 테스트 작성**

`fe/src/features/demo/model/tour-state.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  TOUR_STORAGE_KEY,
  readTourState,
  subscribeTourState,
  writeTourState,
} from "./tour-state";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("저장된 것이 없으면 둘 다 false다", () => {
  expect(readTourState()).toEqual({ uploaded: false, noticeSeen: false });
});

test("patch로 일부만 바꾸고 나머지는 유지한다", () => {
  writeTourState({ noticeSeen: true });
  writeTourState({ uploaded: true });
  expect(readTourState()).toEqual({ uploaded: true, noticeSeen: true });
  expect(JSON.parse(localStorage.getItem(TOUR_STORAGE_KEY)!)).toEqual({
    uploaded: true,
    noticeSeen: true,
  });
});

test("깨진 JSON이나 읽기 실패는 기본값으로 떨어진다", () => {
  localStorage.setItem(TOUR_STORAGE_KEY, "{not json");
  expect(readTourState()).toEqual({ uploaded: false, noticeSeen: false });

  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  try {
    expect(readTourState()).toEqual({ uploaded: false, noticeSeen: false });
  } finally {
    Storage.prototype.getItem = original;
  }
});

test("쓰기 실패는 예외를 던지지 않고 구독자에게는 알린다", () => {
  const cb = vi.fn();
  subscribeTourState(cb);
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new Error("quota");
  };
  try {
    expect(() => writeTourState({ uploaded: true })).not.toThrow();
  } finally {
    Storage.prototype.setItem = original;
  }
  expect(cb).toHaveBeenCalledTimes(1);
});

test("구독자는 쓰기마다 새 상태를 받고, 해지하면 더 받지 않는다", () => {
  const cb = vi.fn();
  const off = subscribeTourState(cb);
  writeTourState({ uploaded: true });
  expect(cb).toHaveBeenLastCalledWith({ uploaded: true, noticeSeen: false });
  off();
  writeTourState({ noticeSeen: true });
  expect(cb).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/demo/model/tour-state.test.ts`
Expected: FAIL — `Cannot find module './tour-state'`

- [ ] **Step 4: tour-state 구현**

`fe/src/features/demo/model/tour-state.ts`:

```ts
/**
 * 데모 둘러보기의 브라우저 로컬 상태(투어 설계 §4.1). 서버는 읽기 전용이라 "테스트
 * 오디오를 올렸는가"는 이 브라우저에만 존재한다. 기존 damwha.demo-notice.v1 키는
 * 흡수한다 — 마이그레이션 없이 재방문자가 모달을 한 번 더 볼 뿐이다.
 */
export const TOUR_STORAGE_KEY = "damwha.demo-tour.v1";

export type TourState = {
  /** 테스트 오디오를 올려 투어 회의가 목록에 드러난 상태. */
  uploaded: boolean;
  /** 첫 방문 모달을 이미 봤다. */
  noticeSeen: boolean;
};

const DEFAULT: TourState = { uploaded: false, noticeSeen: false };

const listeners = new Set<(s: TourState) => void>();

export function readTourState(): TourState {
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<TourState>;
    return {
      uploaded: parsed.uploaded === true,
      noticeSeen: parsed.noticeSeen === true,
    };
  } catch {
    return { ...DEFAULT }; // 사생활 모드 등 — 안내를 한 번 더 보이는 쪽이 안전
  }
}

export function writeTourState(patch: Partial<TourState>): void {
  const next = { ...readTourState(), ...patch };
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 저장 실패는 다음 방문에 다시 보이는 것뿐 */
  }
  for (const cb of listeners) cb(next);
}

export function subscribeTourState(cb: (s: TourState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
```

- [ ] **Step 5: 통과 확인 + 타입 검사**

Run: `cd fe && pnpm vitest run src/features/demo/model/tour-state.test.ts && pnpm exec tsc -b`
Expected: 5 passed, tsc 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add fe/src/shared/config/env.ts fe/src/vite-env.d.ts fe/src/features/demo/model/tour-state.ts fe/src/features/demo/model/tour-state.test.ts
git commit -m "feat(fe): 데모 투어 env 설정과 로컬 상태 저장소를 추가한다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 2: 업로드 시뮬레이션 상태 머신

**Files:**
- Create: `fe/src/features/demo/model/upload-simulation.ts`
- Test: `fe/src/features/demo/model/upload-simulation.test.ts`

**Interfaces:**
- Consumes: `writeTourState` (Task 1)
- Produces:
  ```ts
  export type SimStage = "queued" | "vad" | "diarize" | "identify" | "stt" | "align" | "persist" | "embed";
  export const SIM_TOTAL_MS = 12_000;
  export type SimView = { meetingId: string; stage: SimStage; progress: number }; // progress 0..1 (stage 안)
  export type SimPhase = "idle" | "running" | "done";
  export function startUploadSimulation(meetingId: string, queryClient: QueryClient): void;
  export function simulationView(now?: number): SimView | null; // running일 때만
  export function simulationPhase(): SimPhase;
  export function subscribeSimulation(cb: (view: SimView | null, phase: SimPhase) => void): () => void;
  export function resetSimulation(): void; // 테스트·재시작용
  ```

- [ ] **Step 1: 실패 테스트 작성**

`fe/src/features/demo/model/upload-simulation.test.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { readTourState } from "./tour-state";
import {
  SIM_TOTAL_MS,
  resetSimulation,
  simulationPhase,
  simulationView,
  startUploadSimulation,
  subscribeSimulation,
} from "./upload-simulation";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  resetSimulation();
});
afterEach(() => {
  vi.useRealTimers();
});

function qc() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  return { client, invalidate };
}

test("시작하면 uploaded=true를 저장하고 queued에서 시작한다", () => {
  const { client, invalidate } = qc();
  startUploadSimulation("mtg_7", client);
  expect(readTourState().uploaded).toBe(true);
  expect(simulationPhase()).toBe("running");
  expect(simulationView()).toEqual({ meetingId: "mtg_7", stage: "queued", progress: 0 });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meetings"] });
});

test("stage는 시간에 따라 순서대로 전진하고 progress는 stage 안에서 0→1이다", () => {
  const { client } = qc();
  startUploadSimulation("mtg_7", client);
  vi.advanceTimersByTime(1_000);
  expect(simulationView()?.stage).toBe("vad");
  vi.advanceTimersByTime(1_000); // t=2s, vad는 1~3s
  expect(simulationView()?.progress).toBeCloseTo(0.5, 5);
  vi.advanceTimersByTime(1_000);
  expect(simulationView()?.stage).toBe("diarize");
  vi.advanceTimersByTime(8_000); // t=11s
  expect(simulationView()?.stage).toBe("embed");
});

test("전환마다 구독자와 세 쿼리 키를 알리고, 12초에 done이 된다", () => {
  const { client, invalidate } = qc();
  const cb = vi.fn();
  subscribeSimulation(cb);
  startUploadSimulation("mtg_7", client);
  invalidate.mockClear();
  vi.advanceTimersByTime(SIM_TOTAL_MS);
  expect(simulationPhase()).toBe("done");
  expect(simulationView()).toBeNull();
  // queued→vad→diarize→identify→stt→align→persist→embed→done = 8 transitions
  expect(cb).toHaveBeenCalledTimes(8);
  expect(cb).toHaveBeenLastCalledWith(null, "done");
  const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  expect(keys).toContain(JSON.stringify(["meeting-status", "mtg_7"]));
  expect(keys).toContain(JSON.stringify(["meeting", "mtg_7"]));
  expect(keys).toContain(JSON.stringify(["meetings"]));
});

test("다시 시작하면 이전 타이머를 버리고 처음부터 돈다", () => {
  const { client } = qc();
  startUploadSimulation("mtg_7", client);
  vi.advanceTimersByTime(6_000);
  expect(simulationView()?.stage).toBe("stt");
  startUploadSimulation("mtg_7", client);
  expect(simulationView()?.stage).toBe("queued");
  vi.advanceTimersByTime(6_000);
  expect(simulationView()?.stage).toBe("stt"); // 옛 타이머가 살아 있었다면 이미 embed/done
  expect(simulationPhase()).toBe("running");
});

test("구독 해지 후에는 알림을 받지 않는다", () => {
  const { client } = qc();
  const cb = vi.fn();
  const off = subscribeSimulation(cb);
  startUploadSimulation("mtg_7", client);
  off();
  vi.advanceTimersByTime(SIM_TOTAL_MS);
  expect(cb).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/demo/model/upload-simulation.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`fe/src/features/demo/model/upload-simulation.ts`:

```ts
import type { QueryClient } from "@tanstack/react-query";

import { writeTourState } from "./tour-state";

/**
 * 가짜 업로드 파이프라인(투어 설계 §4.1). 워커 없이 브라우저 타이머로 stage를 전진시키고,
 * 전환마다 회의 쿼리를 invalidate해 폴링 주기(2초)를 기다리지 않게 한다. 실제 응답 가공은
 * demo-tour-interceptor가 simulationView()를 읽어서 한다.
 */
export type SimStage =
  | "queued"
  | "vad"
  | "diarize"
  | "identify"
  | "stt"
  | "align"
  | "persist"
  | "embed";

/** 각 stage의 시작 시각(ms). 마지막 stage는 SIM_TOTAL_MS에서 끝난다. */
export const STAGE_TIMELINE: readonly [SimStage, number][] = [
  ["queued", 0],
  ["vad", 1_000],
  ["diarize", 3_000],
  ["identify", 5_000],
  ["stt", 6_000],
  ["align", 9_000],
  ["persist", 10_000],
  ["embed", 11_000],
];
export const SIM_TOTAL_MS = 12_000;

export type SimView = { meetingId: string; stage: SimStage; progress: number };
export type SimPhase = "idle" | "running" | "done";
type Listener = (view: SimView | null, phase: SimPhase) => void;

type State =
  | { phase: "idle" }
  | { phase: "running"; meetingId: string; startedAt: number }
  | { phase: "done"; meetingId: string };

let state: State = { phase: "idle" };
let timers: ReturnType<typeof setTimeout>[] = [];
const listeners = new Set<Listener>();

function stageAt(elapsed: number): { stage: SimStage; progress: number } {
  let idx = 0;
  for (let i = 0; i < STAGE_TIMELINE.length; i++) {
    if (elapsed >= STAGE_TIMELINE[i][1]) idx = i;
  }
  const [stage, start] = STAGE_TIMELINE[idx];
  const end = idx + 1 < STAGE_TIMELINE.length ? STAGE_TIMELINE[idx + 1][1] : SIM_TOTAL_MS;
  const progress = Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
  return { stage, progress };
}

export function simulationView(now = Date.now()): SimView | null {
  if (state.phase !== "running") return null;
  const { stage, progress } = stageAt(now - state.startedAt);
  return { meetingId: state.meetingId, stage, progress };
}

export function simulationPhase(): SimPhase {
  return state.phase;
}

export function subscribeSimulation(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  const view = simulationView();
  for (const cb of listeners) cb(view, state.phase);
}

function invalidate(qc: QueryClient, meetingId: string) {
  void qc.invalidateQueries({ queryKey: ["meeting-status", meetingId] });
  void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
  void qc.invalidateQueries({ queryKey: ["meetings"] });
}

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

export function resetSimulation(): void {
  clearTimers();
  state = { phase: "idle" };
}

export function startUploadSimulation(meetingId: string, qc: QueryClient): void {
  clearTimers();
  state = { phase: "running", meetingId, startedAt: Date.now() };
  // 회의가 목록에 "uploaded" 상태로 등장하게 — 인터셉터의 숨김 필터가 풀린다.
  writeTourState({ uploaded: true });
  invalidate(qc, meetingId);

  for (const [, at] of STAGE_TIMELINE.slice(1)) {
    timers.push(
      setTimeout(() => {
        invalidate(qc, meetingId);
        notify();
      }, at),
    );
  }
  timers.push(
    setTimeout(() => {
      state = { phase: "done", meetingId };
      timers = [];
      invalidate(qc, meetingId);
      notify();
    }, SIM_TOTAL_MS),
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd fe && pnpm vitest run src/features/demo/model/upload-simulation.test.ts && pnpm exec tsc -b`
Expected: 5 passed

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/demo/model/upload-simulation.ts fe/src/features/demo/model/upload-simulation.test.ts
git commit -m "feat(fe): 데모 업로드를 12초 stage 타이머로 재생하는 시뮬레이션을 추가한다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 3: 응답 인터셉터(숨김·덮어쓰기)와 설치

**Files:**
- Create: `fe/src/features/demo/api/demo-tour-interceptor.ts`
- Test: `fe/src/features/demo/api/demo-tour-interceptor.test.ts`
- Modify: `fe/src/app/providers.tsx`

**Interfaces:**
- Consumes: `readTourState` (Task 1), `simulationView` (Task 2)
- Produces:
  ```ts
  export function installDemoTour(client: AxiosInstance, opts: {
    tourMeetingId: string;
    isUploaded: () => boolean;
    view: () => SimView | null;
  }): void;
  ```

- [ ] **Step 1: 실패 테스트 작성**

`fe/src/features/demo/api/demo-tour-interceptor.test.ts`:

```ts
import axios from "axios";
import { expect, test, vi } from "vitest";

import type { SimView } from "../model/upload-simulation";
import { installDemoTour } from "./demo-tour-interceptor";

const TOUR = "mtg_7";

function client(data: unknown) {
  const adapter = vi.fn(async (config) => ({
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  }));
  return axios.create({ baseURL: "http://api.test/api", adapter });
}

function install(
  c: ReturnType<typeof client>,
  { uploaded = false, view = null }: { uploaded?: boolean; view?: SimView | null } = {},
) {
  installDemoTour(c, { tourMeetingId: TOUR, isUploaded: () => uploaded, view: () => view });
}

test("업로드 전: GET /meetings에서 투어 회의를 뺀다", async () => {
  const c = client([{ id: "mtg_5" }, { id: TOUR }, { id: "mtg_6" }]);
  install(c);
  const { data } = await c.get("/meetings");
  expect(data.map((m: { id: string }) => m.id)).toEqual(["mtg_5", "mtg_6"]);
});

test("업로드 전: POST /search·GET /lenses·GET /saved-utterances에서 투어 회의 항목을 뺀다", async () => {
  const s = client({ results: [{ meetingId: TOUR }, { meetingId: "mtg_5" }] });
  install(s);
  expect((await s.post("/search", { q: "x" })).data.results).toEqual([{ meetingId: "mtg_5" }]);

  const l = client({ items: [{ meeting_id: TOUR }, { meeting_id: "mtg_5" }], next_cursor: null });
  install(l);
  expect((await l.get("/lenses?kind=action")).data.items).toEqual([{ meeting_id: "mtg_5" }]);

  const u = client({ items: [{ meeting: { id: TOUR } }, { meeting: { id: "mtg_5" } }], next_cursor: null });
  install(u);
  expect((await u.get("/saved-utterances")).data.items).toEqual([{ meeting: { id: "mtg_5" } }]);
});

test("업로드 전: GET /saved-utterances/ids와 GET /meetings/:id는 건드리지 않는다", async () => {
  const ids = client({ utterance_ids: ["u1"] });
  install(ids);
  expect((await ids.get("/saved-utterances/ids?meeting_id=mtg_7")).data).toEqual({ utterance_ids: ["u1"] });

  const d = client({ id: TOUR, status: "done" });
  install(d);
  expect((await d.get(`/meetings/${TOUR}`)).data).toEqual({ id: TOUR, status: "done" });
});

test("업로드 후·시뮬레이션 없음: 응답을 그대로 흘린다", async () => {
  const c = client([{ id: TOUR, status: "done" }]);
  install(c, { uploaded: true });
  expect((await c.get("/meetings")).data).toEqual([{ id: TOUR, status: "done" }]);
});

test("시뮬레이션 중: 목록·상세의 status와 /status 응답을 덮어쓴다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "stt", progress: 0.25 };
  const list = client([{ id: TOUR, status: "done" }, { id: "mtg_5", status: "done" }]);
  install(list, { uploaded: true, view });
  expect((await list.get("/meetings")).data).toEqual([
    { id: TOUR, status: "processing" },
    { id: "mtg_5", status: "done" },
  ]);

  const detail = client({ id: TOUR, status: "done", utterances: [1] });
  install(detail, { uploaded: true, view });
  expect((await detail.get(`/meetings/${TOUR}`)).data).toEqual({
    id: TOUR,
    status: "processing",
    utterances: [1],
  });

  const status = client({ status: "done", stage: null, progress: null, error: null, summary: { status: "done" }, search_index: { status: "done" } });
  install(status, { uploaded: true, view });
  expect((await status.get(`/meetings/${TOUR}/status`)).data).toEqual({
    status: "processing",
    stage: "stt",
    progress: 0.25,
    error: null,
    summary: { status: "queued", model: null, error: null },
    search_index: { status: "queued", error: null, updated_at: expect.any(String) },
  });
});

test("시뮬레이션 중이라도 다른 회의 응답은 그대로다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "vad", progress: 0 };
  const c = client({ id: "mtg_5", status: "done" });
  install(c, { uploaded: true, view });
  expect((await c.get("/meetings/mtg_5")).data).toEqual({ id: "mtg_5", status: "done" });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/demo/api/demo-tour-interceptor.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`fe/src/features/demo/api/demo-tour-interceptor.ts`:

```ts
import type { AxiosInstance, AxiosResponse } from "axios";

import type { SimView } from "../model/upload-simulation";

type Opts = {
  tourMeetingId: string;
  isUploaded: () => boolean;
  view: () => SimView | null;
};

/** baseURL·/api 접두를 벗긴 경로. demo-read-only.ts와 같은 규칙. */
function pathOf(res: AxiosResponse): string {
  return (res.config.url ?? "")
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/api/, "")
    .split("?")[0]
    .replace(/\/$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 데모 둘러보기의 응답 가공(투어 설계 §4.2·§4.3). 업로드 전엔 투어 회의를 목록류 응답에서
 * 숨기고, 시뮬레이션이 도는 동안엔 그 회의의 상태를 processing/stage로 덮어쓴다.
 * 그 밖의 응답과 404는 손대지 않는다.
 */
export function installDemoTour(client: AxiosInstance, opts: Opts): void {
  const { tourMeetingId: tour } = opts;
  const isTour = (v: unknown) => v === tour;

  client.interceptors.response.use((res) => {
    const method = (res.config.method ?? "get").toLowerCase();
    const path = pathOf(res);
    const data: unknown = res.data;

    if (!opts.isUploaded()) {
      if (method === "get" && path === "/meetings" && Array.isArray(data)) {
        res.data = data.filter((m) => !isRecord(m) || !isTour(m.id));
      } else if (method === "post" && path === "/search" && isRecord(data) && Array.isArray(data.results)) {
        res.data = { ...data, results: data.results.filter((h) => !isRecord(h) || !isTour(h.meetingId)) };
      } else if (method === "get" && (path === "/lenses" || path === "/saved-utterances") && isRecord(data) && Array.isArray(data.items)) {
        res.data = {
          ...data,
          items: data.items.filter((it) => {
            if (!isRecord(it)) return true;
            const meeting = isRecord(it.meeting) ? it.meeting : null;
            return !isTour(it.meeting_id) && !isTour(meeting?.id);
          }),
        };
      }
      return res;
    }

    const view = opts.view();
    if (!view || view.meetingId !== tour || method !== "get") return res;

    if (path === "/meetings" && Array.isArray(data)) {
      res.data = data.map((m) => (isRecord(m) && isTour(m.id) ? { ...m, status: "processing" } : m));
    } else if (path === `/meetings/${tour}` && isRecord(data)) {
      res.data = { ...data, status: "processing" };
    } else if (path === `/meetings/${tour}/status`) {
      res.data = {
        status: "processing",
        stage: view.stage,
        progress: view.progress,
        error: null,
        summary: { status: "queued", model: null, error: null },
        search_index: { status: "queued", error: null, updated_at: new Date().toISOString() },
      };
    }
    return res;
  });
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd fe && pnpm vitest run src/features/demo/api/demo-tour-interceptor.test.ts`
Expected: 6 passed

- [ ] **Step 5: providers.tsx에서 설치**

`fe/src/app/providers.tsx` — 기존 import 아래에 추가하고, 모듈 최상위에서 설치한다(첫 요청보다
먼저 붙어야 한다. 모델·인터셉터 모듈은 React가 없어 정적 import 허용 — Global Constraints).

```ts
import { installDemoTour } from "@/features/demo/api/demo-tour-interceptor";
import { readTourState } from "@/features/demo/model/tour-state";
import { simulationView } from "@/features/demo/model/upload-simulation";
import { apiClient } from "@/shared/api/client";

// 데모 투어의 응답 가공(투어 설계 §2.7). 회의 id가 없으면 투어는 업로드 단계 없이 돈다.
if (env.demoTour) {
  installDemoTour(apiClient, {
    tourMeetingId: env.demoTour.meetingId,
    isUploaded: () => readTourState().uploaded,
    view: simulationView,
  });
}
```

- [ ] **Step 6: 전체 타입·테스트**

Run: `cd fe && pnpm exec tsc -b && pnpm vitest run`
Expected: 통과

- [ ] **Step 7: 커밋**

```bash
git add fe/src/features/demo/api fe/src/app/providers.tsx
git commit -m "feat(fe): 데모 투어 회의를 숨기고 처리 상태를 덮어쓰는 응답 인터셉터를 붙인다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 4: 스포트라이트 타깃 `data-tour` 속성

**Files:**
- Modify: `fe/src/features/meeting/ui/left-nav.tsx` (검색 필드 래퍼 div, NewMeetingItem 버튼, `<ul aria-label="회의 목록">`)
- Modify: `fe/src/features/meeting/ui/upload-dialog.tsx` (제출 `<Button type="submit">`)
- Modify: `fe/src/pages/meeting.tsx` (ProcessingBanner 루트 div)
- Modify: `fe/src/features/meeting/ui/transcript-pane.tsx` (첫 발화)
- Modify: `fe/src/features/meeting/ui/player-bar.tsx` (루트 div)
- Modify: `fe/src/features/meeting/ui/insight-pane.tsx` (탭 트리거 2개, 렌즈 래퍼)
- Modify: `fe/src/shared/ui/command-bar.tsx` (DialogPrimitive.Content)

**Interfaces:**
- Produces: 아래 셀렉터. Task 6의 단계 정의와 정적 테스트가 이 값을 그대로 쓴다.

| 값 | 요소 |
|---|---|
| `search-trigger` | LeftNav의 `<div className="mb-3 px-0.5">` (SearchField 래퍼) |
| `new-meeting` | `NewMeetingItem`의 `<button>` |
| `meeting-list` | `<ul aria-label="회의 목록">` |
| `upload-submit` | UploadDialog `<Button type="submit">업로드</Button>` |
| `processing-banner` | ProcessingBanner `<div role="status">` |
| `utterance` | 전사의 **첫** `<Utterance>` |
| `player-bar` | PlayerBar 루트 `<div>` |
| `insight-tab-summary` / `insight-tab-note` | `<TabsTrigger value="summary">` / `value="notes"` |
| `lens-section` | `Todos`+`Decisions`+`LensState`를 감싸는 새 `<div>` |
| `search-palette` | CommandBar `DialogPrimitive.Content` |

- [ ] **Step 1: 속성 추가**

`left-nav.tsx`:

```tsx
// NewMeetingItem 안
<button
  type="button"
  data-tour="new-meeting"
  onClick={onClick}
  …
// LeftNav 본문
<div className="mb-3 px-0.5" data-tour="search-trigger">
  <SearchField asButton … />
</div>
…
<ul
  data-tour="meeting-list"
  className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain"
  aria-label="회의 목록"
```

`upload-dialog.tsx` 제출 버튼:

```tsx
<Button
  type="submit"
  data-tour="upload-submit"
  loading={upload.isPending}
```

`pages/meeting.tsx` ProcessingBanner:

```tsx
<div
  role="status"
  aria-busy="true"
  data-tour="processing-banner"
```

`transcript-pane.tsx` — map에 index를 받아 첫 발화에만:

```tsx
{meeting.utterances.map((u, i) => {
  const failed = u.status === "transcribe_failed";
  return (
    <Utterance
      key={u.id}
      data-uid={u.id}
      {...(i === 0 ? { "data-tour": "utterance" } : {})}
```

`player-bar.tsx` 루트:

```tsx
<div
  data-tour="player-bar"
  className={cn(
    "flex shrink-0 items-center border-t border-border bg-[var(--surface-card)] px-5 pt-2.5 pb-3",
```

`insight-pane.tsx`:

```tsx
<TabsTrigger value="summary" data-tour="insight-tab-summary">요약</TabsTrigger>
…
<TabsTrigger value="notes" data-tour="insight-tab-note">메모</TabsTrigger>
…
{/* 투어 스포트라이트 타깃 — Todos/Decisions는 0건이면 null이라 래퍼가 필요하다 */}
<div data-tour="lens-section">
  <Todos lenses={lenses} meeting={meeting} onToggle={onToggle} />
  <Decisions lenses={lenses} onMore={() => onOpenLens("decision")} />
  <LensState … />
</div>
```

`command-bar.tsx`:

```tsx
<DialogPrimitive.Content
  data-tour="search-palette"
  className="fixed top-[12vh] …"
  aria-label="명령 팔레트"
>
```

- [ ] **Step 2: 기존 테스트가 깨지지 않는지 확인**

Run: `cd fe && pnpm exec tsc -b && pnpm vitest run && pnpm lint`
Expected: 전부 통과 (속성만 추가했으므로)

- [ ] **Step 3: 커밋**

```bash
git add fe/src/features/meeting/ui fe/src/pages/meeting.tsx fe/src/shared/ui/command-bar.tsx
git commit -m "feat(fe): 데모 투어가 스포트라이트할 요소에 data-tour 속성을 단다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 5: 업로드 모달의 데모 분기

**Files:**
- Create: `fe/src/features/demo/ui/demo-upload-source.tsx`
- Modify: `fe/src/features/meeting/ui/upload-dialog.tsx`
- Test: `fe/src/features/meeting/ui/upload-dialog.test.tsx` (추가)

**Interfaces:**
- Consumes: `env.demoTour` (Task 1), `startUploadSimulation` (Task 2)
- Produces: `DemoUploadSource({ fileLabel: string })` — 파일 행 대체 표시

- [ ] **Step 1: 실패 테스트 추가**

`upload-dialog.test.tsx` 끝에 추가. `env`는 모듈이라 `vi.mock`으로 데모 값을 준다. 파일 상단
import 아래에 넣되 **hoisting** 때문에 `vi.mock`은 다른 import보다 먼저 평가된다는 점만
기억한다(`vi.mock`은 자동 hoist).

```tsx
import * as sim from "@/features/demo/model/upload-simulation";

vi.mock("@/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/shared/config/env")>();
  return {
    env: {
      ...mod.env,
      demoMode: true,
      demoTour: { meetingId: "mtg_7", fileLabel: "테스트.m4a · 42.0 MB", searchQuery: "프롬프트" },
    },
  };
});

test("데모: 파일 선택 대신 테스트 오디오가 놓이고, 제출은 시뮬레이션만 시작한다", async () => {
  const post = vi.spyOn(apiClient, "post");
  const start = vi.spyOn(sim, "startUploadSimulation").mockImplementation(() => {});
  const onUploaded = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UploadDialog open onOpenChange={() => {}} onUploaded={onUploaded} />
    </QueryClientProvider>,
  );

  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(screen.getByText("테스트.m4a · 42.0 MB")).toBeInTheDocument();
  expect(screen.getByText(/데모라 파일을 받지 않아요/)).toBeInTheDocument();

  const submit = screen.getByRole("button", { name: "업로드" });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);

  await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("mtg_7"));
  expect(start).toHaveBeenCalledWith("mtg_7", qc);
  expect(post).not.toHaveBeenCalled();
});
```

**주의:** 이 `vi.mock`은 파일 전체에 걸리므로 기존 테스트(파일 input을 찾는 것들)가 깨진다.
따라서 데모 테스트는 **별도 파일** `fe/src/features/meeting/ui/upload-dialog.demo.test.tsx`에
둔다. 위 코드 블록을 그 파일로 옮기고, 필요한 import(`fireEvent, render, screen, waitFor`,
`QueryClient, QueryClientProvider`, `expect, test, vi`, `apiClient`, `UploadDialog`)를 상단에 쓴다.

- [ ] **Step 2: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/meeting/ui/upload-dialog.demo.test.tsx`
Expected: FAIL — `input[type="file"]`가 아직 존재 / 텍스트 없음

- [ ] **Step 3: DemoUploadSource 작성**

`fe/src/features/demo/ui/demo-upload-source.tsx`:

```tsx
import { Icon } from "@/features/meeting/ui/icons";

/**
 * 데모 빌드의 업로드 모달에서 파일 선택 행을 대체한다(투어 설계 §2.4). 파일을 받지 않는
 * 이유는 배포 설계 §3.3의 원문 그대로 — 심사자가 아무 파일이나 넣었는데 같은 결과가 나오면
 * 나머지도 가짜로 의심한다. 받지 않으면 "저장 안 함"이 사실이 된다.
 */
export function DemoUploadSource({ fileLabel }: { fileLabel: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[color:var(--text-secondary)]">
        오디오 파일
      </span>
      <div className="flex items-center gap-2.5 rounded-sm border border-[color:var(--accent-6)] bg-[var(--accent-1)] px-2.5 py-2">
        <Icon name="mic" size={15} className="shrink-0 text-[color:var(--accent-text)]" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{fileLabel}</span>
      </div>
      <p className="text-xs leading-relaxed text-[color:var(--text-muted)]">
        데모라 파일을 받지 않아요. 미리 준비한 테스트 오디오로 처리 흐름을 보여드려요.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: UploadDialog 분기**

`upload-dialog.tsx` 변경점:

```tsx
// import 추가
import { useQueryClient } from "@tanstack/react-query";
import { env } from "@/shared/config/env";
import { DemoUploadSource } from "@/features/demo/ui/demo-upload-source";
import { startUploadSimulation } from "@/features/demo/model/upload-simulation";

// 컴포넌트 안, upload 선언 근처
const queryClient = useQueryClient();
const demoTour = env.demoTour; // null이면 실제 업로드 경로

// handleSubmit 맨 앞에 데모 경로
const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
  if (demoTour) {
    if (!isSpeakerBoundsValid(speakers)) return;
    startUploadSimulation(demoTour.meetingId, queryClient);
    toast({ variant: "success", title: "업로드 완료", description: "회의 처리를 시작했어요." });
    resetForm();
    onOpenChange(false);
    onUploaded(demoTour.meetingId);
    return;
  }
  if (!file || upload.isPending || !isSpeakerBoundsValid(speakers)) return;
  upload.mutate(/* 기존 그대로 */);
};

// JSX: 파일 행을 조건부로
{demoTour ? (
  <DemoUploadSource fileLabel={demoTour.fileLabel} />
) : (
  <div className="flex flex-col gap-1.5">
    {/* 기존 파일 선택 행 그대로 */}
  </div>
)}

// 제출 버튼 disabled
disabled={
  (!demoTour && !file) || upload.isPending || !isSpeakerBoundsValid(speakers)
}
```

`DemoUploadSource`는 React 컴포넌트지만 크기가 작고 UploadDialog 자체가 이미 lazy 청크(회의
라우트) 안에 있으므로 정적 import로 둔다.

- [ ] **Step 5: 통과 확인**

Run: `cd fe && pnpm vitest run src/features/meeting/ui/ && pnpm exec tsc -b`
Expected: 데모 테스트 1 + 기존 업로드 테스트 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/demo/ui/demo-upload-source.tsx fe/src/features/meeting/ui/upload-dialog.tsx fe/src/features/meeting/ui/upload-dialog.demo.test.tsx
git commit -m "feat(fe): 데모 업로드 모달이 파일 대신 테스트 오디오로 시뮬레이션을 시작한다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 6: waitFor 유틸, 단계 정의, 러너

**Files:**
- Create: `fe/src/features/demo/lib/wait-for.ts`
- Test: `fe/src/features/demo/lib/wait-for.test.ts`
- Create: `fe/src/features/demo/lib/tour-steps.ts`
- Test: `fe/src/features/demo/lib/tour-steps.test.ts`
- Create: `fe/src/features/demo/lib/tour-runner.ts`
- Create: `fe/src/features/demo/tour.css`
- Modify: `fe/package.json` (driver.js)

**Interfaces:**
- Consumes: `env.demoTour`, `writeTourState`, `subscribeSimulation`/`simulationPhase`, `router` (`@/app/router`)
- Produces:
  ```ts
  // wait-for.ts
  export function waitFor(selector: string, timeoutMs?: number): Promise<HTMLElement | null>;
  export function clickTour(name: string): boolean; // [data-tour=name] 또는 그 안의 첫 button을 click
  // tour-steps.ts
  export type TourStep = {
    id: string; target: string; title: string; description: string;
    side?: "top" | "right" | "bottom" | "left"; align?: "start" | "center" | "end";
    prepare?: () => Promise<void>;   // 이 단계를 하이라이트하기 전에 실행
    live?: boolean;                  // 시뮬레이션 진행을 description에 반영, done까지 다음 비활성
  };
  export function buildTourSteps(ctx: { navigate: (to: string) => void; searchQuery: string; hasUpload: boolean }): TourStep[];
  export function stageNarration(stage: SimStage): string;
  // tour-runner.ts
  export const tourRunner: {
    start(queryClient: QueryClient): void;
    stop(): void;                      // 확인 없이 즉시 종료
    isActive(): boolean;
    isNavigating(): boolean;           // 투어가 직접 하는 라우트 이동 중
    requestExit(): void;               // ESC·오버레이·X → 구독자에게 알림
    onExitRequest(cb: () => void): () => void;
  };
  ```

- [ ] **Step 1: driver.js 설치**

Run: `cd fe && pnpm add driver.js@1.8.0`
Expected: `package.json` dependencies에 `"driver.js": "1.8.0"`, 루트 lockfile 갱신

- [ ] **Step 2: wait-for 실패 테스트**

`fe/src/features/demo/lib/wait-for.test.ts`:

```ts
import { afterEach, expect, test, vi } from "vitest";

import { clickTour, waitFor } from "./wait-for";

afterEach(() => {
  document.body.innerHTML = "";
});

test("이미 있는 요소는 즉시 돌려준다", async () => {
  document.body.innerHTML = '<div data-tour="a"></div>';
  expect(await waitFor('[data-tour="a"]')).toBe(document.querySelector('[data-tour="a"]'));
});

test("나중에 나타나는 요소를 기다린다", async () => {
  const p = waitFor('[data-tour="b"]', 1000);
  setTimeout(() => {
    document.body.innerHTML = '<div data-tour="b"></div>';
  }, 20);
  expect(await p).not.toBeNull();
});

test("타임아웃이면 null", async () => {
  expect(await waitFor('[data-tour="none"]', 30)).toBeNull();
});

test("clickTour는 요소가 button이면 그것을, 아니면 안의 첫 button을 누른다", () => {
  const onA = vi.fn();
  const onB = vi.fn();
  document.body.innerHTML =
    '<button data-tour="a"></button><div data-tour="b"><button id="inner"></button></div>';
  document.querySelector('[data-tour="a"]')!.addEventListener("click", onA);
  document.querySelector("#inner")!.addEventListener("click", onB);
  expect(clickTour("a")).toBe(true);
  expect(clickTour("b")).toBe(true);
  expect(clickTour("zzz")).toBe(false);
  expect(onA).toHaveBeenCalledTimes(1);
  expect(onB).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/demo/lib/wait-for.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: wait-for 구현**

`fe/src/features/demo/lib/wait-for.ts`:

```ts
/** 셀렉터가 DOM에 나타날 때까지 기다린다. 타임아웃이면 null — 호출자가 단계를 건너뛴다. */
export function waitFor(selector: string, timeoutMs = 3000): Promise<HTMLElement | null> {
  const found = document.querySelector<HTMLElement>(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        clearTimeout(timer);
        obs.disconnect();
        resolve(el);
      }
    });
    const timer = setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeoutMs);
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

export function tourSelector(name: string): string {
  return `[data-tour="${name}"]`;
}

/** data-tour 요소를 누른다. 요소가 버튼이 아니면 그 안의 첫 버튼을 누른다. */
export function clickTour(name: string): boolean {
  const el = document.querySelector<HTMLElement>(tourSelector(name));
  if (!el) return false;
  const target = el instanceof HTMLButtonElement ? el : el.querySelector<HTMLElement>("button");
  if (!target) return false;
  target.click();
  return true;
}

/** React가 관리하는 input에 값을 넣는다(native setter + input 이벤트). */
export function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 5: wait-for 통과 확인**

Run: `cd fe && pnpm vitest run src/features/demo/lib/wait-for.test.ts`
Expected: 4 passed

- [ ] **Step 6: tour-steps 정적 테스트 작성**

`fe/src/features/demo/lib/tour-steps.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { buildTourSteps, stageNarration } from "./tour-steps";
import { STAGE_TIMELINE } from "../model/upload-simulation";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(readFileSync(p, "utf8"));
  }
  return out;
}

const SRC = sources(join(__dirname, "../../../"));

test("모든 단계의 data-tour 타깃이 소스에 실제로 존재한다", () => {
  const steps = buildTourSteps({ navigate: () => {}, searchQuery: "x", hasUpload: true, suppressExit: (fn) => fn() });
  for (const s of steps) {
    const needle = `data-tour="${s.target}"`;
    const dynamic = `"data-tour": "${s.target}"`;
    expect(
      SRC.some((src) => src.includes(needle) || src.includes(dynamic)),
      `${s.id}: ${needle}`,
    ).toBe(true);
  }
});

test("업로드 회의가 없으면 업로드 관련 단계가 빠지고 순서는 유지된다", () => {
  const withUpload = buildTourSteps({ navigate: () => {}, searchQuery: "", hasUpload: true, suppressExit: (fn) => fn() }).map((s) => s.id);
  const without = buildTourSteps({ navigate: () => {}, searchQuery: "", hasUpload: false, suppressExit: (fn) => fn() }).map((s) => s.id);
  expect(withUpload).toEqual([
    "list", "new", "upload", "processing", "utterance", "player", "summary", "lens", "search", "note",
  ]);
  expect(without).toEqual(["list", "utterance", "player", "summary", "lens", "search", "note"]);
});

test("모든 시뮬레이션 stage에 서술 문구가 있다", () => {
  for (const [stage] of STAGE_TIMELINE) {
    expect(stageNarration(stage).length).toBeGreaterThan(10);
  }
});
```

- [ ] **Step 7: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/demo/lib/tour-steps.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 8: tour-steps 구현**

`fe/src/features/demo/lib/tour-steps.ts`:

```ts
import type { SimStage } from "../model/upload-simulation";
import { clickTour, setReactInputValue, sleep, tourSelector, waitFor } from "./wait-for";

export type TourStep = {
  id: string;
  /** data-tour 값. */
  target: string;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** 이 단계를 하이라이트하기 전에 화면을 준비한다(라우트 이동·모달 열기·탭 전환). */
  prepare?: () => Promise<void>;
  /** 시뮬레이션 진행을 description에 반영하고 done 전엔 "다음"을 막는다. */
  live?: boolean;
};

const NARRATION: Record<SimStage, string> = {
  queued: "워커가 작업을 집어 들길 기다리는 중이에요.",
  vad: "음성 구간 감지(VAD) — 침묵을 걷어내고 말이 있는 구간만 남겨요.",
  diarize: "화자 분리 — 목소리 특징으로 \"누가 언제 말했는지\" 구간을 나눠요.",
  identify: "화자 식별 — 나뉜 목소리를 등록된 성문(voiceprint)과 대조해요.",
  stt: "받아쓰기 — Whisper가 구간별로 텍스트를 만들어요.",
  align: "정렬 — 텍스트를 화자·시각에 맞춰 발화 단위로 붙여요.",
  persist: "저장 — 발화를 DB에 쓰고 원본 오디오와 연결해요.",
  embed: "색인 — 검색용 임베딩을 만들고, 이어서 렌즈 추출과 요약이 돌아요.",
};

export function stageNarration(stage: SimStage): string {
  return NARRATION[stage];
}

export const PROCESSING_FOOTNOTE =
  "실제로는 10분 회의에 몇 분이 걸리고, 이 처리는 Apple Silicon 로컬에서만 돌아요. 데모는 그 흐름을 12초로 재생해요.";

type Ctx = {
  navigate: (to: string) => void;
  searchQuery: string;
  hasUpload: boolean;
  /** 프로그램적 Escape 동안 러너의 종료 훅을 무시한다(tourRunner.withExitSuppressed). */
  suppressExit: <T>(fn: () => T) => T;
};

/** Escape를 document에 보내 Radix 다이얼로그를 닫는다. 러너가 이 동안 자기 종료 훅을 무시한다. */
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

export function buildTourSteps(ctx: Ctx): TourStep[] {
  const upload: TourStep[] = ctx.hasUpload
    ? [
        {
          id: "new",
          target: "new-meeting",
          title: "새 대화는 오디오에서 시작해요",
          description: "회의·인터뷰·통화 녹음을 올리면 화자 분리와 전사가 자동으로 돌아요.",
          side: "right",
        },
        {
          id: "upload",
          target: "upload-submit",
          title: "테스트 오디오로 올려볼게요",
          description:
            "데모는 파일을 받지 않아요. 미리 준비한 테스트 오디오가 놓여 있으니 그대로 업로드해요. 제목·녹음 일시·처리 설정은 실제 업로드와 같은 폼이에요.",
          side: "top",
          align: "end",
          prepare: async () => {
            clickTour("new-meeting");
            await waitFor(tourSelector("upload-submit"));
          },
        },
        {
          id: "processing",
          target: "processing-banner",
          title: "처리 중이에요",
          description: NARRATION.queued,
          side: "bottom",
          live: true,
          prepare: async () => {
            clickTour("upload-submit");
            await waitFor(tourSelector("processing-banner"), 5000);
          },
        },
      ]
    : [];

  return [
    {
      id: "list",
      target: "meeting-list",
      title: "처리된 대화가 여기 쌓여요",
      description: ctx.hasUpload
        ? "지금은 샘플 2건이에요. 각 대화는 화자별 발화·요약·렌즈까지 갖고 있어요."
        : "각 대화는 화자별 발화·요약·렌즈까지 갖고 있어요.",
      side: "right",
      prepare: async () => {
        ctx.navigate("/");
        await waitFor(tourSelector("meeting-list"));
      },
    },
    ...upload,
    {
      id: "utterance",
      target: "utterance",
      title: "발화 하나하나가 원본으로 이어져요",
      description:
        "발화는 화자·시각·원본 오디오를 갖고 있어요. \"원문 보기\"를 누르면 그 순간으로 재생이 점프해요 — 방금 눌러봤어요.",
      side: "right",
      prepare: async () => {
        const el = await waitFor(tourSelector("utterance"), 15_000);
        const jump = Array.from(el?.querySelectorAll("button") ?? []).find((b) =>
          b.textContent?.includes("원문 보기"),
        );
        jump?.click();
      },
    },
    {
      id: "player",
      target: "player-bar",
      title: "화자별 구간과 재생",
      description: "타임라인은 화자별로 색이 달라요. 배속을 바꾸거나 발화 단위로 앞뒤로 옮길 수 있어요.",
      side: "top",
    },
    {
      id: "summary",
      target: "insight-tab-summary",
      title: "요약",
      description: "참석자, 주요 주제, 단락별 요약이 자동으로 만들어져요. 요약 모델은 바꿔서 다시 만들 수 있어요.",
      side: "left",
      prepare: async () => {
        clickTour("insight-tab-summary");
        await sleep(150);
      },
    },
    {
      id: "lens",
      target: "lens-section",
      title: "렌즈 — 할 일·결정·약속",
      description: "대화에서 액션·결정·약속을 자동으로 뽑아요. 사람이 고치거나 지울 수 있고, 다시 뽑아도 손댄 항목은 남아요.",
      side: "left",
      prepare: async () => {
        document.querySelector(tourSelector("lens-section"))?.scrollIntoView({ block: "center" });
        await sleep(150);
      },
    },
    {
      id: "search",
      target: "search-palette",
      title: "모든 대화를 가로질러 검색",
      description: `⌘K로 어디서든 발화를 찾아요. "${ctx.searchQuery}"를 넣어봤어요 — 결과를 고르면 그 발화로 바로 점프해요.`,
      side: "bottom",
      prepare: async () => {
        clickTour("search-trigger");
        const input = await waitFor('[data-tour="search-palette"] input[role="combobox"]');
        if (input instanceof HTMLInputElement && ctx.searchQuery) {
          setReactInputValue(input, ctx.searchQuery);
          await sleep(400); // 250ms 디바운스 + 첫 결과
        }
      },
    },
    {
      id: "note",
      target: "insight-tab-note",
      title: "메모, 그리고 끝",
      description:
        "대화를 들으며 마크다운 메모를 남길 수 있어요. 여기까지가 둘러보기예요 — 이 데모는 읽기 전용이고, 오디오는 NotebookLM이 생성한 샘플이에요. 왼쪽 아래 \"둘러보기\"로 언제든 다시 볼 수 있어요.",
      side: "left",
      prepare: async () => {
        ctx.suppressExit(() => pressEscape());
        await sleep(200);
        clickTour("insight-tab-note");
        await sleep(150);
      },
    },
  ];
}
```

- [ ] **Step 9: tour-steps 통과 확인**

Run: `cd fe && pnpm vitest run src/features/demo/lib/tour-steps.test.ts`
Expected: 3 passed (Task 4의 속성이 전부 있으므로)

- [ ] **Step 10: 팝오버 스타일**

`fe/src/features/demo/tour.css`:

```css
/* driver.js 팝오버를 디자인 토큰에 맞춘다. 토큰은 index.css의 :root에 정의돼 있다. */
.driver-popover.damwha-tour {
  background: var(--surface-card);
  color: var(--text-primary, currentColor);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 16px 18px;
  max-width: 360px;
  font-family: inherit;
}
.driver-popover.damwha-tour .driver-popover-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.driver-popover.damwha-tour .driver-popover-description {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.driver-popover.damwha-tour .driver-popover-progress-text {
  font-size: 11px;
  color: var(--text-faint);
}
.driver-popover.damwha-tour .driver-popover-navigation-btns button {
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-card);
  color: inherit;
  text-shadow: none;
  font-size: 12.5px;
  padding: 5px 10px;
}
.driver-popover.damwha-tour .driver-popover-next-btn {
  background: var(--accent-solid);
  border-color: var(--accent-solid);
  color: #fff;
}
.driver-popover.damwha-tour .driver-popover-next-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.driver-popover.damwha-tour .driver-popover-arrow-side-left.driver-popover-arrow { border-left-color: var(--surface-card); }
.driver-popover.damwha-tour .driver-popover-arrow-side-right.driver-popover-arrow { border-right-color: var(--surface-card); }
.driver-popover.damwha-tour .driver-popover-arrow-side-top.driver-popover-arrow { border-top-color: var(--surface-card); }
.driver-popover.damwha-tour .driver-popover-arrow-side-bottom.driver-popover-arrow { border-bottom-color: var(--surface-card); }
```

토큰 이름은 `fe/src/index.css`의 `:root`에서 확인한다 — `--surface-card`, `--border`,
`--shadow-lg`, `--text-secondary`, `--text-faint`, `--accent-solid`는 기존 컴포넌트가 이미 쓴다.
`--text-primary`가 없으면 그 줄을 지운다(`fe/src/design-tokens.test.ts`가 정의 안 된 토큰
참조를 잡는다면 그 테스트가 알려준다).

- [ ] **Step 11: tour-runner 구현**

`fe/src/features/demo/lib/tour-runner.ts`:

```ts
import type { QueryClient } from "@tanstack/react-query";
import { driver, type Driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import "../tour.css";

import { router } from "@/app/router";
import { env } from "@/shared/config/env";

import { writeTourState } from "../model/tour-state";
import {
  simulationPhase,
  simulationView,
  subscribeSimulation,
  type SimStage,
} from "../model/upload-simulation";
import {
  PROCESSING_FOOTNOTE,
  buildTourSteps,
  stageNarration,
  type TourStep,
} from "./tour-steps";
import { tourSelector } from "./wait-for";

/**
 * driver.js 래퍼(투어 설계 §3·§4.5·§4.6). 단계마다 prepare를 먼저 돌려 화면을 준비하고,
 * 타깃이 3초 안에 안 나타나면 그 단계를 건너뛴다. 종료(ESC·오버레이·X)는 곧바로 끝내지
 * 않고 requestExit로 알린다 — TourNavigationGuard가 확인 모달을 띄우고 stop()을 부른다.
 */
let active: Driver | null = null;
let steps: TourStep[] = [];
let navigating = false;
let suppressExit = false;
let liveCleanup: (() => void) | null = null;
const exitListeners = new Set<() => void>();

function navigate(to: string) {
  navigating = true;
  void router.navigate(to).finally(() => {
    navigating = false;
  });
}

function toDriveStep(step: TourStep, index: number): DriveStep {
  return {
    element: tourSelector(step.target),
    popover: {
      title: step.title,
      description: step.description,
      side: step.side,
      align: step.align,
      onPopoverRender: step.live
        ? (popover) => {
            liveCleanup?.();
            const render = () => {
              const phase = simulationPhase();
              const view = phase === "running" ? stageNarration(currentStage()) : "처리가 끝났어요. 다음으로 넘어가면 전사 결과가 보여요.";
              popover.description.innerHTML = `${view}<br/><br/><span style="font-size:11.5px;opacity:.75">${PROCESSING_FOOTNOTE}</span>`;
              popover.nextButton.disabled = phase === "running";
            };
            render();
            const off = subscribeSimulation(render);
            liveCleanup = () => {
              off();
              liveCleanup = null;
            };
          }
        : undefined,
    },
    onDeselected: () => {
      liveCleanup?.();
    },
    // index는 advance()가 다음 단계를 찾을 때 쓴다.
    data: { index },
  };
}

function currentStage(): SimStage {
  return simulationView()?.stage ?? "queued";
}

/** i번째 단계부터 prepare→타깃 확인을 반복해 실제로 보여줄 단계 인덱스를 찾는다. -1이면 끝. */
async function resolveFrom(i: number): Promise<number> {
  for (let idx = i; idx < steps.length; idx++) {
    const step = steps[idx];
    try {
      await step.prepare?.();
    } catch (e) {
      console.warn(`[tour] prepare failed: ${step.id}`, e);
    }
    if (document.querySelector(tourSelector(step.target))) return idx;
    console.warn(`[tour] target missing, skipping: ${step.id}`);
  }
  return -1;
}

async function advance(from: number) {
  if (!active) return;
  const idx = await resolveFrom(from + 1);
  if (!active) return; // 준비 중에 종료됨
  if (idx < 0) {
    stop();
    return;
  }
  active.drive(idx);
}

export const tourRunner = {
  start(queryClient: QueryClient): void {
    if (active) active.destroy();
    // 재시작: 투어 회의를 다시 숨긴다(§4.5).
    writeTourState({ uploaded: false });
    void queryClient.invalidateQueries({ queryKey: ["meetings"] });
    void queryClient.invalidateQueries({ queryKey: ["lenses"] });
    void queryClient.invalidateQueries({ queryKey: ["saved-utterances"] });

    steps = buildTourSteps({
      navigate,
      searchQuery: env.demoTour?.searchQuery ?? "",
      hasUpload: env.demoTour != null,
      suppressExit: tourRunner.withExitSuppressed,
    });

    const d = driver({
      animate: true,
      showProgress: true,
      progressText: "{{current}} / {{total}}",
      nextBtnText: "다음",
      prevBtnText: "이전",
      doneBtnText: "끝내기",
      showButtons: ["next", "close"],
      popoverClass: "damwha-tour",
      stagePadding: 6,
      stageRadius: 8,
      overlayOpacity: 0.55,
      allowClose: true,
      steps: steps.map(toDriveStep),
      onNextClick: (_el, step) => {
        const i = (step.data as { index: number }).index;
        void advance(i);
      },
      onDoneClick: () => stop(),
      onCloseClick: () => tourRunner.requestExit(),
      onDestroyStarted: () => {
        if (suppressExit) return;
        tourRunner.requestExit();
      },
      onDestroyed: () => {
        liveCleanup?.();
        active = null;
      },
    });
    active = d;
    void resolveFrom(0).then((idx) => {
      if (!active) return;
      if (idx < 0) stop();
      else d.drive(idx);
    });
  },

  stop(): void {
    if (!active) return;
    const d = active;
    active = null;
    suppressExit = true;
    try {
      d.destroy();
    } finally {
      suppressExit = false;
    }
  },

  isActive: () => active !== null,
  isNavigating: () => navigating,

  requestExit(): void {
    for (const cb of exitListeners) cb();
  },
  onExitRequest(cb: () => void): () => void {
    exitListeners.add(cb);
    return () => {
      exitListeners.delete(cb);
    };
  },

  /** 단계 prepare가 프로그램적으로 Escape를 보낼 때 driver의 종료 훅을 잠시 무시한다. */
  withExitSuppressed<T>(fn: () => T): T {
    suppressExit = true;
    try {
      return fn();
    } finally {
      suppressExit = false;
    }
  },
};
```

`tourRunner`가 자기 메서드 `withExitSuppressed`를 `start()` 안에서 참조하는 것은 객체 리터럴이
이미 평가된 뒤라 문제없다.

- [ ] **Step 12: 타입·린트·전체 테스트**

Run: `cd fe && pnpm exec tsc -b && pnpm lint && pnpm vitest run`
Expected: 통과. `driver.js` 타입은 패키지에 포함돼 있다(`DriveStep`, `Driver`, `PopoverDOM`).

- [ ] **Step 13: 커밋**

```bash
git add fe/package.json pnpm-lock.yaml fe/src/features/demo/lib fe/src/features/demo/tour.css
git commit -m "feat(fe): driver.js 기반 데모 둘러보기 러너와 10단계 정의를 추가한다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 7: 종료 확인 모달과 라우트 가드

**Files:**
- Create: `fe/src/features/demo/ui/tour-exit-dialog.tsx`
- Create: `fe/src/features/demo/ui/tour-navigation-guard.tsx`
- Test: `fe/src/features/demo/ui/tour-navigation-guard.test.tsx`
- Modify: `fe/src/app/app-shell.tsx`

**Interfaces:**
- Consumes: `tourRunner` (Task 6)
- Produces: `TourExitDialog({ open, onContinue, onQuit })`, `TourNavigationGuard()` (props 없음)

- [ ] **Step 1: 실패 테스트 작성**

`fe/src/features/demo/ui/tour-navigation-guard.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const runner = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    active: false,
    navigating: false,
    stop: vi.fn(),
    isActive: () => runner.active,
    isNavigating: () => runner.navigating,
    onExitRequest: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emitExit: () => listeners.forEach((cb) => cb()),
  };
});
vi.mock("@/features/demo/lib/tour-runner", () => ({ tourRunner: runner }));

const blocker = vi.hoisted(() => ({
  state: "unblocked" as "unblocked" | "blocked",
  proceed: vi.fn(),
  reset: vi.fn(),
  shouldBlock: null as null | ((a: { currentLocation: { pathname: string }; nextLocation: { pathname: string } }) => boolean),
}));
vi.mock("react-router", () => ({
  useBlocker: (fn: typeof blocker.shouldBlock) => {
    blocker.shouldBlock = fn;
    return blocker;
  },
}));

import { TourNavigationGuard } from "./tour-navigation-guard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  runner.active = false;
  runner.navigating = false;
  blocker.state = "unblocked";
});

test("투어가 비활성이면 라우트 이동을 막지 않는다", () => {
  render(<TourNavigationGuard />);
  expect(
    blocker.shouldBlock!({ currentLocation: { pathname: "/" }, nextLocation: { pathname: "/settings" } }),
  ).toBe(false);
});

test("투어 활성 중 사용자의 라우트 이동은 막고, 투어 자신의 이동은 통과시킨다", () => {
  render(<TourNavigationGuard />);
  runner.active = true;
  expect(
    blocker.shouldBlock!({ currentLocation: { pathname: "/" }, nextLocation: { pathname: "/settings" } }),
  ).toBe(true);
  runner.navigating = true;
  expect(
    blocker.shouldBlock!({ currentLocation: { pathname: "/" }, nextLocation: { pathname: "/meetings/mtg_7" } }),
  ).toBe(false);
});

test("차단되면 모달이 뜨고, 계속하면 reset, 그만두면 stop + proceed", async () => {
  const user = userEvent.setup();
  blocker.state = "blocked";
  render(<TourNavigationGuard />);
  expect(screen.getByRole("dialog", { name: /그만둘까요/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "계속 둘러보기" }));
  expect(blocker.reset).toHaveBeenCalled();

  blocker.state = "blocked";
  cleanup();
  render(<TourNavigationGuard />);
  await user.click(screen.getByRole("button", { name: "그만두기" }));
  expect(runner.stop).toHaveBeenCalled();
  expect(blocker.proceed).toHaveBeenCalled();
});

test("ESC 등 종료 요청이 오면 모달이 뜨고, 그만두면 stop만 부른다", async () => {
  const user = userEvent.setup();
  render(<TourNavigationGuard />);
  expect(screen.queryByRole("dialog")).toBeNull();
  runner.emitExit();
  expect(await screen.findByRole("dialog", { name: /그만둘까요/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "그만두기" }));
  expect(runner.stop).toHaveBeenCalled();
  expect(blocker.proceed).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/demo/ui/tour-navigation-guard.test.tsx`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: TourExitDialog**

`fe/src/features/demo/ui/tour-exit-dialog.tsx`:

```tsx
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

type Props = { open: boolean; onContinue: () => void; onQuit: () => void };

/** 둘러보기 종료 확인(투어 설계 §2.6). driver 오버레이(z-index 10000) 위에 떠야 한다. */
export function TourExitDialog({ open, onContinue, onQuit }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onContinue())}>
      <DialogContent showCloseButton={false} className="z-[10050]">
        <DialogHeader>
          <DialogTitle>둘러보기를 그만둘까요?</DialogTitle>
          <DialogDescription>
            아직 보여드릴 단계가 남아 있어요. 그만둬도 왼쪽 아래 "둘러보기"로 다시 시작할 수 있어요.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onQuit}>
            그만두기
          </Button>
          <Button autoFocus onClick={onContinue}>
            계속 둘러보기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`DialogContent`의 오버레이도 `z-[100]`이라 driver 아래에 깔린다. `dialog.tsx`의 Overlay
클래스에 `className` 병합이 없다면, `DialogContent`가 Overlay를 함께 그리는 구조인지 확인하고
필요하면 `DialogContent`에 `overlayClassName?: string` prop을 추가해 `z-[10050]`을 같이
넘긴다(변경은 `fe/src/shared/ui/dialog.tsx` 한 곳, 기본값은 기존과 동일).

- [ ] **Step 4: TourNavigationGuard**

`fe/src/features/demo/ui/tour-navigation-guard.tsx`:

```tsx
import * as React from "react";
import { useBlocker } from "react-router";

import { tourRunner } from "../lib/tour-runner";
import { TourExitDialog } from "./tour-exit-dialog";

/**
 * 투어 중 라우트 이동(네비 클릭·뒤로가기)과 driver의 종료 요청(ESC·오버레이·X)을 한 모달로
 * 받는다(투어 설계 §4.6). 투어 자신의 이동은 isNavigating()으로 통과시킨다.
 */
export function TourNavigationGuard() {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      tourRunner.isActive() &&
      !tourRunner.isNavigating() &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  const [exitAsked, setExitAsked] = React.useState(false);

  React.useEffect(() => tourRunner.onExitRequest(() => setExitAsked(true)), []);

  const blocked = blocker.state === "blocked";
  const open = blocked || exitAsked;

  const onContinue = () => {
    setExitAsked(false);
    if (blocked) blocker.reset();
  };
  const onQuit = () => {
    setExitAsked(false);
    tourRunner.stop();
    if (blocked) blocker.proceed();
  };

  return <TourExitDialog open={open} onContinue={onContinue} onQuit={onQuit} />;
}
```

- [ ] **Step 5: AppShell에 렌더(데모 빌드만, lazy)**

`fe/src/app/app-shell.tsx`:

```tsx
import { Suspense, lazy } from "react";
import { env } from "@/shared/config/env";

const TourNavigationGuard = lazy(() =>
  import("@/features/demo/ui/tour-navigation-guard").then((m) => ({
    default: m.TourNavigationGuard,
  })),
);
// return 안, CommandBar 옆
{env.demoMode ? (
  <Suspense fallback={null}>
    <TourNavigationGuard />
  </Suspense>
) : null}
```

- [ ] **Step 6: 통과 확인**

Run: `cd fe && pnpm vitest run src/features/demo/ui/tour-navigation-guard.test.tsx && pnpm exec tsc -b && pnpm vitest run`
Expected: 4 passed, 전체 통과 (`app-shell`을 쓰는 기존 라우트 테스트가 `env.demoMode=false`라 가드를 로드하지 않음)

- [ ] **Step 7: 커밋**

```bash
git add fe/src/features/demo/ui/tour-exit-dialog.tsx fe/src/features/demo/ui/tour-navigation-guard.tsx fe/src/features/demo/ui/tour-navigation-guard.test.tsx fe/src/app/app-shell.tsx fe/src/shared/ui/dialog.tsx
git commit -m "feat(fe): 둘러보기 중 ESC·라우트 이동을 종료 확인 모달로 받는다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 8: 첫 방문 모달 개편과 네비 둘러보기 버튼

**Files:**
- Modify: `fe/src/features/demo/ui/demo-notice-dialog.tsx`
- Modify: `fe/src/features/demo/ui/demo-notice-dialog.test.tsx`
- Create: `fe/src/features/demo/ui/tour-launch-button.tsx`
- Modify: `fe/src/features/meeting/ui/left-nav.tsx`

**Interfaces:**
- Consumes: `readTourState`/`writeTourState` (Task 1), `tourRunner.start(queryClient)` (Task 6)
- Produces: `DemoNoticeDialog()`, `TourLaunchButton()`

- [ ] **Step 1: 모달 테스트 갱신**

`demo-notice-dialog.test.tsx` 전체 교체:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const runner = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@/features/demo/lib/tour-runner", () => ({ tourRunner: runner }));

import { readTourState } from "@/features/demo/model/tour-state";
import { DemoNoticeDialog } from "@/features/demo/ui/demo-notice-dialog";

function renderDialog() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <DemoNoticeDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("첫 방문이면 안내 모달이 열리고 두 버튼이 있다", () => {
  renderDialog();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /데모/ })).toBeInTheDocument();
  expect(screen.getByText(/NotebookLM/)).toBeInTheDocument();
  expect(screen.getByText(/읽기 전용/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "둘러보기 시작" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "그냥 볼게요" })).toBeInTheDocument();
});

test("둘러보기 시작 → 닫히고 러너를 시작하며 다음 방문엔 안 뜬다", async () => {
  const user = userEvent.setup();
  const { unmount } = renderDialog();
  await user.click(screen.getByRole("button", { name: "둘러보기 시작" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(runner.start).toHaveBeenCalledTimes(1);
  expect(readTourState().noticeSeen).toBe(true);
  unmount();
  renderDialog();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("그냥 볼게요 → 닫히기만 한다", async () => {
  const user = userEvent.setup();
  renderDialog();
  await user.click(screen.getByRole("button", { name: "그냥 볼게요" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(runner.start).not.toHaveBeenCalled();
  expect(readTourState().noticeSeen).toBe(true);
});

test("localStorage를 못 읽어도 모달은 뜬다", () => {
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  try {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  } finally {
    Storage.prototype.getItem = original;
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd fe && pnpm vitest run src/features/demo/ui/demo-notice-dialog.test.tsx`
Expected: FAIL — 버튼 이름 불일치

- [ ] **Step 3: 모달 개편**

`demo-notice-dialog.tsx` 전체 교체:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { tourRunner } from "../lib/tour-runner";
import { readTourState, writeTourState } from "../model/tour-state";

/**
 * 공개 데모 첫 방문 안내이자 둘러보기 입구(투어 설계 §2.3). 데모 빌드에서만 providers가
 * lazy로 붙인다. 정직성 항목(NotebookLM 샘플·읽기 전용)은 짧게 남긴다.
 */
export function DemoNoticeDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(() => !readTourState().noticeSeen);

  function close() {
    writeTourState({ noticeSeen: true });
    setOpen(false);
  }

  function startTour() {
    close();
    tourRunner.start(queryClient);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Damwha 공개 데모예요</DialogTitle>
          <DialogDescription>
            대화 녹음을 올리면 화자별 발화·요약·할 일로 정리해 주는 서비스예요. 둘러보기가
            업로드부터 검색까지 1분 남짓에 보여드려요.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-sm leading-normal text-[color:var(--text-secondary)]">
          <li>
            회의 오디오는 Google NotebookLM이 생성한{" "}
            <strong className="font-medium text-foreground">AI 대화 샘플</strong>이에요. 실제
            인물의 음성이 아니에요.
          </li>
          <li>결과는 이 샘플을 실제 파이프라인으로 처리한 그대로예요.</li>
          <li>읽기 전용 데모라 편집·저장은 막혀 있어요.</li>
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            그냥 볼게요
          </Button>
          <Button autoFocus onClick={startTour}>
            둘러보기 시작
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`DemoNoticeDialog`는 `providers.tsx`에서 `RouterProvider`의 **형제**로 렌더되므로 `useQueryClient`는
되지만 라우터 훅은 못 쓴다 — 러너가 `router.navigate`를 직접 쓰는 이유다.

- [ ] **Step 4: 둘러보기 버튼**

`fe/src/features/demo/ui/tour-launch-button.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";

import { Icon } from "@/features/meeting/ui/icons";

import { tourRunner } from "../lib/tour-runner";

/** LeftNav 하단 상시 버튼(투어 설계 §2.3). 누르면 회의를 다시 숨기고 1단계부터 돈다. */
export function TourLaunchButton() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      data-tour="tour-launch"
      onClick={() => tourRunner.start(queryClient)}
      className="mx-2 mb-2 flex shrink-0 cursor-pointer items-center gap-2 rounded-sm border border-border px-2.5 py-2 text-left text-sm font-medium text-[color:var(--text-secondary)] outline-none transition-colors duration-[80ms] hover:bg-[var(--gray-2)] focus-visible:[box-shadow:var(--focus-ring)]"
    >
      <Icon name="sparkles" size={15} />
      <span className="flex-1">둘러보기</span>
    </button>
  );
}
```

`Icon name="sparkles"`가 `features/meeting/ui/icons.tsx`에 없으면 있는 이름 중 `plus`가 아닌
안내성 아이콘(`info`, `help`, `compass` 등 목록 확인)으로 바꾼다.

- [ ] **Step 5: LeftNav 하단에 lazy 삽입**

`left-nav.tsx`:

```tsx
import { Suspense, lazy } from "react";
import { env } from "@/shared/config/env";

const TourLaunchButton = lazy(() =>
  import("@/features/demo/ui/tour-launch-button").then((m) => ({
    default: m.TourLaunchButton,
  })),
);

// <nav> 안, 목록을 감싼 <div className="flex min-h-0 flex-1 …"> 닫힌 직후·UploadDialog 앞
{env.demoMode ? (
  <Suspense fallback={null}>
    <TourLaunchButton />
  </Suspense>
) : null}
```

- [ ] **Step 6: 통과 확인**

Run: `cd fe && pnpm vitest run src/features/demo && pnpm exec tsc -b && pnpm lint && pnpm vitest run`
Expected: 전부 통과. `left-nav.test.tsx`는 `env.demoMode=false`라 버튼이 없어야 하고, 기존 단언에 영향 없음.

- [ ] **Step 7: 커밋**

```bash
git add fe/src/features/demo/ui fe/src/features/meeting/ui/left-nav.tsx
git commit -m "feat(fe): 첫 방문 모달을 둘러보기 입구로 바꾸고 네비에 재시작 버튼을 둔다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 9: 빌드 주입과 시드 문서

**Files:**
- Create: `demo/seed/tour.json`
- Modify: `deploy/demo/release.sh`
- Modify: `deploy/api.Dockerfile`
- Modify: `deploy/demo/README.md`
- Modify: `fe/.env.example`
- Modify: `docs/superpowers/specs/2026-09-04-demo-guided-tour-design.md` (§5 표의 9단계 타깃을 `search-palette`로)

**Interfaces:**
- Consumes: env 키 3개 (Task 1)

- [ ] **Step 1: tour.json**

`demo/seed/tour.json`:

```json
{
  "meeting_id": "mtg_7",
  "file_label": "AI가_내_머릿속_미지를_사냥하게_하라.m4a · 42.0 MB",
  "search_query": "프롬프트"
}
```

- [ ] **Step 2: release.sh가 읽어 build-arg로 넘긴다**

`deploy/demo/release.sh` — 기존 manifest 검사 루프에 `demo/seed/tour.json` 추가, 그리고
`demo api` 빌드 직전:

```bash
for f in demo/seed/damwha-demo.dump demo/seed/manifest.json demo/seed/tour.json; do
  [ -f "$f" ] || { echo "missing $f — run demo/seed/build.sh first" >&2; exit 1; }
done
…
TOUR_ID=$(python3 -c "import json;print(json.load(open('demo/seed/tour.json'))['meeting_id'])")
TOUR_LABEL=$(python3 -c "import json;print(json.load(open('demo/seed/tour.json'))['file_label'])")
TOUR_QUERY=$(python3 -c "import json;print(json.load(open('demo/seed/tour.json'))['search_query'])")
# 시드 덤프에 그 회의가 실제로 있는지 — 없으면 투어의 업로드 결과가 404다
python3 -c "import json,sys; ids=[m['id'] for m in json.load(open('demo/seed/manifest.json'))]; sys.exit(0 if '$TOUR_ID' in ids else 'tour.json meeting_id not in manifest.json')"

echo "== demo api"
docker buildx build --platform "$PLATFORM" "${OUT_API[@]}" \
  --build-arg VITE_DEMO_MODE=true --build-arg DEMO_SEED=true \
  --build-arg "VITE_DEMO_TOUR_MEETING_ID=$TOUR_ID" \
  --build-arg "VITE_DEMO_TOUR_FILE_LABEL=$TOUR_LABEL" \
  --build-arg "VITE_DEMO_TOUR_SEARCH_QUERY=$TOUR_QUERY" \
  -f deploy/api.Dockerfile .
```

- [ ] **Step 3: Dockerfile ARG**

`deploy/api.Dockerfile` — 상단 ARG 선언과 SPA 빌드 줄:

```dockerfile
ARG VITE_DEMO_MODE=false
ARG DEMO_SEED=false
ARG VITE_DEMO_TOUR_MEETING_ID=
ARG VITE_DEMO_TOUR_FILE_LABEL=
ARG VITE_DEMO_TOUR_SEARCH_QUERY=
…
ARG VITE_DEMO_MODE
ARG VITE_DEMO_TOUR_MEETING_ID
ARG VITE_DEMO_TOUR_FILE_LABEL
ARG VITE_DEMO_TOUR_SEARCH_QUERY
RUN VITE_API_BASE_URL=/api VITE_DEMO_MODE=$VITE_DEMO_MODE \
    VITE_DEMO_TOUR_MEETING_ID=$VITE_DEMO_TOUR_MEETING_ID \
    VITE_DEMO_TOUR_FILE_LABEL="$VITE_DEMO_TOUR_FILE_LABEL" \
    VITE_DEMO_TOUR_SEARCH_QUERY="$VITE_DEMO_TOUR_SEARCH_QUERY" \
    pnpm --filter damwha-fe build
```

- [ ] **Step 4: README와 .env.example**

`deploy/demo/README.md` "시드 갱신" 절 뒤에 추가:

```markdown
## 둘러보기(투어) 회의

`demo/seed/tour.json`이 투어의 "테스트 오디오 업로드" 결과로 드러낼 회의를 정한다
(투어 설계 `docs/superpowers/specs/2026-09-04-demo-guided-tour-design.md`).

- `meeting_id` — `manifest.json`에 있는 id. release.sh가 없으면 실패한다.
- `file_label` — 업로드 모달에 보일 "파일명 · 크기".
- `search_query` — 검색 단계에서 넣을 예시어. 그 회의 전사에 확실히 있는 단어.

시드를 새로 구울 때 체크리스트: 투어 회의는 렌즈가 1건 이상, 요약 done, `demo/audio/`에
원본 m4a 존재(`find-original.py`가 확인). 로컬에서 보려면 `fe/.env.local`에
`VITE_DEMO_MODE=true`와 위 세 값을 `VITE_DEMO_TOUR_*`로 넣고 `pnpm fe dev`.
```

`fe/.env.example`에 추가:

```
# 공개 데모 둘러보기 — deploy/demo/README.md "둘러보기(투어) 회의"
VITE_DEMO_TOUR_MEETING_ID=
VITE_DEMO_TOUR_FILE_LABEL=
VITE_DEMO_TOUR_SEARCH_QUERY=
```

- [ ] **Step 5: 스펙 §5 표 9단계 타깃 정정**

`docs/superpowers/specs/2026-09-04-demo-guided-tour-design.md` §3 표에 `search-palette` 행
추가(CommandBar Content), §5 표 9번 타깃을 `search-palette`로, "진입 시 동작"을
"`search-trigger` click → 팔레트 대기 + `searchQuery` 주입"으로 바꾼다.

- [ ] **Step 6: 커밋**

```bash
git add demo/seed/tour.json deploy/demo/release.sh deploy/api.Dockerfile deploy/demo/README.md fe/.env.example docs/superpowers/specs/2026-09-04-demo-guided-tour-design.md
git commit -m "build(demo): 투어 회의 설정을 tour.json으로 받아 SPA 빌드에 싣는다

Claude-Session: https://claude.ai/code/session_01FEuzDKmJVYKaENZMgxophW"
```

---

### Task 10: 브라우저 검증 (수동·Playwright MCP)

**Files:** 없음 (검증만). 문제가 나오면 해당 Task 파일로 돌아가 고치고 별도 `fix(fe):` 커밋.

- [ ] **Step 1: 로컬 데모 환경**

`fe/.env.local` 작성(gitignore 대상인지 `git check-ignore fe/.env.local`로 확인, 아니면 마치고 지운다):

```
VITE_API_BASE_URL=http://localhost:3000/api
VITE_DEMO_MODE=true
VITE_DEMO_TOUR_MEETING_ID=mtg_7
VITE_DEMO_TOUR_FILE_LABEL=AI가_내_머릿속_미지를_사냥하게_하라.m4a · 42.0 MB
VITE_DEMO_TOUR_SEARCH_QUERY=프롬프트
```

`be/.env`에 `DEMO_READ_ONLY=true`가 켜져 있는지 확인(켜져 있어야 실제 데모와 같은 조건).
Run: `pnpm db:up && pnpm dev` (루트). localStorage의 `damwha.demo-tour.v1`을 지운다.

- [ ] **Step 2: Playwright로 10단계 완주**

`http://localhost:5173` 접속 → 모달 "둘러보기 시작" → 각 단계에서 스크린샷 → 확인 항목:

1. 1단계 목록에 회의 **2건**(mtg_7 없음).
2. 3단계 모달에 파일 input 없음, 라벨 표시, "업로드" 활성.
3. 4단계 배너 stage 라벨이 12초 동안 바뀌고 팝오버 서술도 바뀜. "다음" 비활성 → done에 활성. 목록에 mtg_7이 "처리 중" 뱃지로 등장.
4. 5단계 첫 발화 하이라이트 + 오디오 재생 시작(플레이어 바 시간 진행).
5. 9단계 팔레트에 "프롬프트" 결과.
6. 10단계 메모 탭. "끝내기" → 오버레이 사라짐.
7. 새로고침 → mtg_7 목록에 남음. 네비 "둘러보기" → 회의 사라지고 1단계부터.
8. 투어 중 ESC → 확인 모달, "계속 둘러보기" → 투어 유지. 네비의 "화자 관리" 클릭 → 확인 모달, "그만두기" → 이동.

- [ ] **Step 3: 프로덕션 빌드 확인**

Run: `cd fe && pnpm build && ls dist/assets | grep -i -c tour`
Expected: 빌드 성공, tour 청크 존재. 그리고 `VITE_DEMO_MODE=false pnpm build` 뒤 `grep -l "driver-popover" dist/assets/*.js`가 **비어야** 한다(비데모 번들에 driver 미포함).

- [ ] **Step 4: `.env.local` 정리·최종 커밋**

발견된 수정 사항이 있으면 커밋. `.env.local`이 추적 대상이면 삭제.

---

## 사용자 몫 (코드 밖)

시드 갱신 전에 사용자가 할 일. 계획 실행과 독립이며, 마지막 release 전까지만 끝나면 된다.

1. `be/storage/meetings/mtg_7/original.m4a`를 `demo/audio/AI가_내_머릿속_미지를_사냥하게_하라.m4a`로 복사(`find-original.py`가 이 이름을 찾는다).
2. `demo/seed/build.sh` → 덤프·manifest에 mtg_7 포함 확인.
3. `deploy/demo/release.sh` → 서버에서 `docker compose pull && docker compose down -v && docker compose up -d`.

## 자기 검토 결과

- 스펙 §2.1~§2.8 → Task 1·2·3·5·6·7·8이 각각 담당. §4.2·§4.3 표 → Task 3 테스트가 항목별로 검증. §5 10단계 → Task 6 `buildTourSteps`. §6 → Task 9. §7 → 각 Task 테스트 + Task 10.
- 스펙과 다른 점 1: 9단계 타깃을 `search-trigger`에서 `search-palette`로 바꿈(팔레트가 열리면 트리거는 오버레이 뒤에 가려진다). Task 9에서 스펙 정정.
- 스펙과 다른 점 2: 4단계 popover는 `driver.refresh()`가 아니라 `onPopoverRender`가 잡은 DOM을 직접 갱신한다(refresh는 하이라이트 위치만 다시 계산한다).
- 타입 일관성: `startUploadSimulation(meetingId, queryClient)` 시그니처가 Task 2·5·테스트에서 동일. `tourRunner.start(queryClient)`가 Task 6·8에서 동일. `buildTourSteps`의 Ctx(`navigate`·`searchQuery`·`hasUpload`·`suppressExit`)가 Task 6의 테스트·구현·러너 호출에서 동일.
