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

function currentStage(): SimStage {
  return simulationView()?.stage ?? "queued";
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
              const view =
                phase === "running"
                  ? stageNarration(currentStage())
                  : "처리가 끝났어요. 다음으로 넘어가면 전사 결과가 보여요.";
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
    tourRunner.stop();
    return;
  }
  active.drive(idx);
}

export const tourRunner = {
  start(queryClient: QueryClient): void {
    tourRunner.stop(); // destroy()를 직접 부르면 onDestroyStarted가 종료 확인 모달을 띄운다
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
      onDoneClick: () => tourRunner.stop(),
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
      if (idx < 0) tourRunner.stop();
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
