import type { DetectionDeps, RecordingSnapshot, SuspendReason } from "./meeting-detection";
import type { MicWatchEvent } from "../process/mic-watch";
import { runHandshake, runWithin } from "../windows/recording-bridge";

/**
 * 회의 감지를 앱에 잇는 판단 (스펙 §4). electron을 import하지 않는다 — main.ts는 잎만 주고, 언제 헬퍼를 갈지와
 * 렌더러 호출의 상한은 여기서 정한다.
 */

/** 재기동 백오프의 처음과 끝. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** finish 상한: flush 2초 + 드레인 60초 + POST 10초 + 여유. 넘기면 거부해야 상태 기계가 빠져나온다. */
export const FINISH_TIMEOUT_MS = 75_000;

const SNAPSHOT_SCRIPT = "window.__damwha_desktop.recordingStatus()";
const FINISH_SCRIPT = "window.__damwha_desktop.finishRecording()";
const START_SCRIPT =
  "window.__damwha_desktop?.startDetectedRecording?.() ?? {started:false, reason:'no-bridge'}";
const CANCEL_SCRIPT = "window.__damwha_desktop?.cancelDetectedRecording?.()";

/** 시계를 주입받는 모듈에 줄 실제 타이머. 돌려주는 함수가 취소다. */
export function setTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

/**
 * 렌더러에 녹음 상태를 묻는다. 거부(창·다리 없음)는 `gone`, 상한 초과는 `timeout`이다. 둘은 다르다 — `gone`은
 * 그 자리에서 끊긴 것이고 `timeout`은 봉쇄일 수 있어 상태 기계가 연속 횟수를 센다.
 */
export async function askSnapshot(
  call: () => Promise<unknown>,
  timeoutMs: number,
): Promise<RecordingSnapshot | "timeout" | "gone"> {
  // 파괴된 webContents의 executeJavaScript는 동기로 던진다 (askIsRecording과 같은 이유로 then 안에서 부른다).
  const asked = Promise.resolve()
    .then(call)
    .then(
      (v): RecordingSnapshot | "gone" => (typeof v === "object" && v !== null ? (v as RecordingSnapshot) : "gone"),
      () => "gone" as const,
    );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([asked, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface WatchLoop {
  start(): void;
  stop(): void;
  /** 돌고 있으면 헬퍼를 새로 띄워 전체 스냅숏을 받는다. 꺼져 있으면 아무것도 하지 않는다. */
  restart(): void;
}

export function createWatchLoop(deps: {
  start: (onEvent: (e: MicWatchEvent) => void) => { stop(): void };
  onEvent(e: MicWatchEvent): void;
  setTimer(fn: () => void, ms: number): () => void;
  log(line: string): void;
}): WatchLoop {
  let running = false;
  /** 지금 헬퍼의 세대. 갈아 치운 헬퍼의 늦은 이벤트가 새 헬퍼의 스냅숏을 불명으로 되돌리지 않게 한다. */
  let gen = 0;
  let failures = 0;
  let helper: { stop(): void } | null = null;
  let cancelBackoff: (() => void) | null = null;

  function retire(): void {
    gen++;
    cancelBackoff?.();
    cancelBackoff = null;
    helper?.stop();
    helper = null;
  }

  function onExit(): void {
    helper = null;
    deps.onEvent({ kind: "exit" });
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_MAX_MS);
    failures++;
    deps.log(`mic-watch: 헬퍼가 끝나 ${delay / 1000}초 뒤 다시 띄운다`);
    cancelBackoff = deps.setTimer(() => {
      cancelBackoff = null;
      spawn();
    }, delay);
  }

  function spawn(): void {
    const mine = ++gen;
    try {
      helper = deps.start((e) => {
        if (mine !== gen) return;
        if (e.kind === "exit") return onExit();
        if (e.kind === "snapshot") failures = 0;
        deps.onEvent(e);
      });
    } catch (e) {
      deps.log(`mic-watch: 헬퍼를 띄우지 못했다 — ${e instanceof Error ? e.message : String(e)}`);
      onExit();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      spawn();
    },
    stop() {
      running = false;
      retire();
    },
    restart() {
      if (!running) return;
      retire();
      spawn();
    },
  };
}

/**
 * 상태 기계와 감시 루프를 함께 움직이는 입구. 상태 기계는 멈춘 동안의 스냅숏을 버리고 다음 스냅숏까지 판단하지 않는데
 * 헬퍼는 바뀔 때만 쓰므로, 마지막 사유가 풀릴 때 헬퍼를 갈지 않으면 감지가 깜깜한 채로 남는다.
 */
export function createDetectionControl(deps: {
  detection: {
    suspend(reason: SuspendReason): void;
    resume(reason: SuspendReason): void;
    setEnabled(on: boolean): void;
    dispose(): void;
  };
  loop: WatchLoop;
}) {
  const { detection, loop } = deps;
  const suspended = new Set<SuspendReason>();
  let disposed = false;

  return {
    suspend(reason: SuspendReason): void {
      suspended.add(reason);
      detection.suspend(reason);
    },
    resume(reason: SuspendReason): void {
      if (!suspended.delete(reason)) return;
      detection.resume(reason);
      if (suspended.size === 0) loop.restart();
    },
    /** 꺼 둔 동안 루프는 멈춰 있으므로 켤 때의 start가 곧 새 헬퍼, 곧 전체 스냅숏이다. */
    setEnabled(on: boolean): void {
      if (disposed) return;
      detection.setEnabled(on);
      if (on) loop.start();
      else loop.stop();
    },
    dispose(): void {
      disposed = true;
      detection.dispose();
      loop.stop();
    },
  };
}

/**
 * 상태 기계가 렌더러에 거는 호출과 그 상한. `start`만 상한이 없다 — 사람이 권한 창에 답하는 시간이고 60초는
 * 상태 기계가 잰다. `run`은 렌더러가 없으면 거부해야 한다.
 */
export function createRendererCalls(deps: {
  run(script: string, userGesture?: boolean): Promise<unknown>;
  stopRecording(): Promise<{ stopped: boolean; reason?: string }>;
  /** 담화 창을 앞으로 가져온다. */
  reveal(): void;
  askTimeoutMs: number;
  handshakeTimeoutMs: number;
  log(line: string): void;
}): Pick<DetectionDeps, "start" | "cancelStart" | "stop" | "finish" | "snapshot" | "open"> {
  const { run, askTimeoutMs, log } = deps;

  const ask = (what: string, script: string) =>
    runWithin(() => run(script), {
      timeoutMs: askTimeoutMs,
      onTimeout: () => log(`meeting-detection: ${what}에 ${askTimeoutMs}ms 안에 답이 없다`),
    });

  return {
    start: () => run(START_SCRIPT, true) as ReturnType<DetectionDeps["start"]>,
    cancelStart: () => ask("cancelStart", CANCEL_SCRIPT),
    async stop() {
      const result = await runHandshake(deps.stopRecording, { timeoutMs: deps.handshakeTimeoutMs });
      if (result.kind !== "stopped") {
        log(`meeting-detection: 녹음을 멈추지 못했다 (${result.kind === "failed" ? result.detail : result.kind})`);
      }
      return result;
    },
    async finish() {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`finish가 ${FINISH_TIMEOUT_MS}ms를 넘겼다`)), FINISH_TIMEOUT_MS);
      });
      try {
        await Promise.race([run(FINISH_SCRIPT), expired]);
      } finally {
        clearTimeout(timer);
      }
    },
    snapshot: () => askSnapshot(() => run(SNAPSHOT_SCRIPT), askTimeoutMs),
    open(meetingId) {
      deps.reveal();
      const script = `window.__damwha_desktop?.openMeeting?.(${JSON.stringify(meetingId)})`;
      ask("open", script).catch((e: unknown) => log(`meeting-detection: 회의를 열지 못했다 ${String(e)}`));
    },
  };
}
