import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { TourStep } from "./tour-steps";

/**
 * driver.js를 통째로 가짜로 바꾼다. 러너가 넘긴 config(steps·훅)를 잡아 두고, drive/destroy
 * 호출만 기록한다. 실제 driver는 DOM 오버레이·애니메이션을 그리므로 jsdom에서 돌릴 이유가 없다.
 */
type FakeDriver = {
  drive: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  config: Record<string, unknown>;
};
const drivers = vi.hoisted(() => ({ made: [] as FakeDriver[] }));
vi.mock("driver.js", () => ({
  driver: (config: Record<string, unknown>) => {
    const d: FakeDriver = { drive: vi.fn(), destroy: vi.fn(), config };
    drivers.made.push(d);
    return d;
  },
}));
vi.mock("driver.js/dist/driver.css", () => ({}));
vi.mock("../tour.css", () => ({}));

const router = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve()),
  state: { location: { pathname: "/" } },
}));
vi.mock("@/app/router", () => ({ router }));

vi.mock("@/shared/config/env", () => ({
  env: {
    demoMode: true,
    demoTour: {
      meetingId: "mtg_7",
      fileLabel: "x.m4a",
      searchQuery: "프롬프트",
    },
  },
}));

const tourState = vi.hoisted(() => ({ writeTourState: vi.fn() }));
vi.mock("../model/tour-state", () => tourState);

const sim = vi.hoisted(() => ({
  phase: "idle" as "idle" | "running" | "done",
  simulationPhase: () => sim.phase,
  simulationView: () => null,
  subscribeSimulation: () => () => {},
}));
vi.mock("../model/upload-simulation", () => sim);

const stepsMock = vi.hoisted(() => ({
  steps: [] as TourStep[],
  buildTourSteps: vi.fn(() => stepsMock.steps),
  stageNarration: () => "",
  PROCESSING_FOOTNOTE: "",
}));
vi.mock("./tour-steps", () => stepsMock);

import { tourRunner } from "./tour-runner";

const qc = {
  invalidateQueries: vi.fn(() => Promise.resolve()),
} as unknown as QueryClient;

function mount(...names: string[]) {
  for (const name of names) {
    const el = document.createElement("div");
    el.setAttribute("data-tour", name);
    document.body.appendChild(el);
  }
}

function step(id: string, extra: Partial<TourStep> = {}): TourStep {
  return { id, target: id, title: id, description: id, ...extra };
}

/** 마이크로태스크와 짧은 타이머가 다 돌 때까지. resolveFrom→drive 연쇄가 여기 안에서 끝난다. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function latest(): FakeDriver {
  return drivers.made[drivers.made.length - 1];
}

function hook<T extends (...a: never[]) => unknown>(
  d: FakeDriver,
  name: string,
): T {
  return d.config[name] as T;
}

beforeEach(() => {
  drivers.made.length = 0;
  document.body.innerHTML = "";
  sim.phase = "idle";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  tourRunner.stop();
  vi.restoreAllMocks();
});

test("start: 첫 단계 prepare를 돌린 뒤 타깃이 있는 단계에서 drive를 부른다", async () => {
  const prepare = vi.fn(async () => {
    mount("a");
  });
  stepsMock.steps = [step("a", { prepare }), step("b")];
  tourRunner.start(qc);
  expect(tourRunner.isActive()).toBe(true);
  expect(tourState.writeTourState).toHaveBeenCalledWith({ uploaded: false });
  await settle();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(latest().drive).toHaveBeenCalledWith(0);
});

test("start: 타깃이 없는 단계는 건너뛰고, 전부 없으면 투어를 끝낸다", async () => {
  mount("b");
  stepsMock.steps = [step("a"), step("b")];
  tourRunner.start(qc);
  await settle();
  expect(latest().drive).toHaveBeenCalledWith(1);

  document.body.innerHTML = "";
  stepsMock.steps = [step("a")];
  tourRunner.start(qc);
  await settle();
  expect(latest().drive).not.toHaveBeenCalled();
  expect(latest().destroy).toHaveBeenCalled();
  expect(tourRunner.isActive()).toBe(false);
});

test("prepare가 도는 동안만 isNavigating이 참이다", async () => {
  let seen: boolean | null = null;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  stepsMock.steps = [
    step("a", {
      prepare: async () => {
        seen = tourRunner.isNavigating();
        await gate;
        mount("a");
      },
    }),
  ];
  tourRunner.start(qc);
  await settle();
  expect(seen).toBe(true);
  expect(tourRunner.isNavigating()).toBe(true);
  release();
  await settle();
  expect(tourRunner.isNavigating()).toBe(false);
  expect(latest().drive).toHaveBeenCalledWith(0);
});

test("prepare가 던져도 플래그를 되돌리고 다음 단계로 넘어간다", async () => {
  mount("b");
  stepsMock.steps = [
    step("a", {
      prepare: async () => {
        throw new Error("boom");
      },
    }),
    step("b"),
  ];
  tourRunner.start(qc);
  await settle();
  expect(tourRunner.isNavigating()).toBe(false);
  expect(latest().drive).toHaveBeenCalledWith(1);
});

test("onNextClick: 다음 단계를 준비해 drive하고, 준비 중 중복 클릭은 무시한다", async () => {
  mount("a");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const prepare = vi.fn(async () => {
    await gate;
    mount("b");
  });
  stepsMock.steps = [step("a"), step("b", { prepare })];
  tourRunner.start(qc);
  await settle();
  const d = latest();
  const onNext = hook<(el: unknown, s: { data: { index: number } }) => void>(
    d,
    "onNextClick",
  );
  const fromA = { data: { index: 0 } };
  onNext(undefined, fromA);
  onNext(undefined, fromA);
  onNext(undefined, fromA);
  await settle();
  expect(prepare).toHaveBeenCalledTimes(1);
  release();
  await settle();
  expect(d.drive).toHaveBeenLastCalledWith(1);
  expect(d.drive).toHaveBeenCalledTimes(2);
});

test("onNextClick: live 단계는 시뮬레이션이 도는 동안 넘어가지 않는다", async () => {
  mount("proc", "b");
  stepsMock.steps = [step("proc", { live: true }), step("b")];
  tourRunner.start(qc);
  await settle();
  const d = latest();
  const onNext = hook<(el: unknown, s: { data: { index: number } }) => void>(
    d,
    "onNextClick",
  );

  sim.phase = "running";
  onNext(undefined, { data: { index: 0 } });
  await settle();
  expect(d.drive).toHaveBeenCalledTimes(1);

  sim.phase = "done";
  onNext(undefined, { data: { index: 0 } });
  await settle();
  expect(d.drive).toHaveBeenLastCalledWith(1);
});

test("onNextClick: 남은 단계의 타깃이 전부 없으면 투어를 끝낸다", async () => {
  mount("a");
  stepsMock.steps = [step("a"), step("b")];
  tourRunner.start(qc);
  await settle();
  const d = latest();
  hook<(el: unknown, s: { data: { index: number } }) => void>(d, "onNextClick")(
    undefined,
    {
      data: { index: 0 },
    },
  );
  await settle();
  expect(d.destroy).toHaveBeenCalled();
  expect(tourRunner.isActive()).toBe(false);
});

test("준비 중에 start가 다시 불리면 낡은 driver는 drive되지 않는다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  stepsMock.steps = [
    step("a", {
      prepare: async () => {
        await gate;
        mount("a");
      },
    }),
  ];
  tourRunner.start(qc);
  const stale = latest();
  tourRunner.start(qc);
  const fresh = latest();
  expect(fresh).not.toBe(stale);
  expect(stale.destroy).toHaveBeenCalled();
  release();
  await settle();
  expect(stale.drive).not.toHaveBeenCalled();
  expect(fresh.drive).toHaveBeenCalledWith(0);
});

test("stop: driver를 destroy하고 비활성이 된다. 두 번 불러도 안전하다", async () => {
  mount("a");
  stepsMock.steps = [step("a")];
  tourRunner.start(qc);
  await settle();
  const d = latest();
  tourRunner.stop();
  expect(d.destroy).toHaveBeenCalledTimes(1);
  expect(tourRunner.isActive()).toBe(false);
  tourRunner.stop();
  expect(d.destroy).toHaveBeenCalledTimes(1);
});

test("ESC·오버레이(onDestroyStarted)와 X(onCloseClick)는 곧바로 끝내지 않고 종료 요청만 알린다", async () => {
  mount("a");
  stepsMock.steps = [step("a")];
  tourRunner.start(qc);
  await settle();
  const d = latest();
  const asked = vi.fn();
  const off = tourRunner.onExitRequest(asked);

  hook<() => void>(d, "onDestroyStarted")();
  hook<() => void>(d, "onCloseClick")();
  expect(asked).toHaveBeenCalledTimes(2);
  expect(d.destroy).not.toHaveBeenCalled();
  expect(tourRunner.isActive()).toBe(true);

  off();
  tourRunner.requestExit();
  expect(asked).toHaveBeenCalledTimes(2);
});

test("끝내기(onDoneClick)는 투어를 멈추고 첫 화면으로 돌려놓는다", async () => {
  mount("a");
  stepsMock.steps = [step("a")];
  tourRunner.start(qc);
  await settle();
  const d = latest();
  hook<() => void>(d, "onDoneClick")();
  expect(d.destroy).toHaveBeenCalled();
  expect(tourRunner.isActive()).toBe(false);
  expect(router.navigate).toHaveBeenCalledWith("/");
});

test("재시작하면 투어 회의를 다시 숨기고 목록 캐시를 무효화한다", async () => {
  mount("a");
  stepsMock.steps = [step("a")];
  tourRunner.start(qc);
  await settle();
  const keys = (
    qc.invalidateQueries as ReturnType<typeof vi.fn>
  ).mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
  expect(keys).toEqual(
    expect.arrayContaining(["meetings", "lenses", "saved-utterances"]),
  );
  expect(stepsMock.buildTourSteps).toHaveBeenLastCalledWith(
    expect.objectContaining({ hasUpload: true, searchQuery: "프롬프트" }),
  );
});
