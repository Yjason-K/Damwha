import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type { SpawnFn } from "./tool-runner";

/**
 * 마이크 감시 헬퍼(`native/mic-watch/main.swift`)를 띄우고 거두는 순수 모듈. electron을 import하지 않는다 —
 * vitest가 부를 수 있어야 한다.
 *
 * 헬퍼의 계약(main.swift 머리 주석과 짝): stdout은 줄 단위 JSON. 기동 직후 전체 스냅숏 한 줄, 이후 마이크를
 * 쓰는 앱 집합이 바뀔 때만 한 줄. 조회가 실패하면 `{"error":"<단계> <OSStatus>"}`를 쓰고 비정상 코드로 끝난다.
 * stdin이 닫히거나 SIGTERM을 받으면 스스로 끝난다.
 */

/** `build-system-audio.sh`가 스테이징하는 파일 이름. dev `desktop/build/system-audio`, packaged `Resources/system-audio`. */
export const MIC_WATCH_HELPER = "damwha-mic-watch";

export function micWatchHelperPath(bundleDir: string): string {
  return path.join(bundleDir, MIC_WATCH_HELPER);
}

/** stdin을 닫은 뒤 스스로 끝나기를 기다리는 시간. 넘기면 SIGTERM, 다시 넘기면 SIGKILL. */
export const STOP_GRACE_MS = 1_000;

export type MicWatchEvent =
  | { kind: "snapshot"; input: string[] }
  | { kind: "error"; detail: string }
  | { kind: "exit" };

/** 한 줄을 이벤트로. 모르는 줄은 null — 오류 줄을 빈 스냅숏으로 읽으면 "마이크 해제"로 오해한다. */
export function parseMicWatchLine(line: string): MicWatchEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { input, error } = value as { input?: unknown; error?: unknown };
  if (Array.isArray(input) && input.every((s) => typeof s === "string")) return { kind: "snapshot", input };
  if (typeof error === "string") return { kind: "error", detail: error };
  return null;
}

export interface MicWatchOptions {
  spawnFn?: SpawnFn;
  stopGraceMs?: number;
}

/** 헬퍼를 띄운다. 끝나면(정상·비정상·실행 실패) `exit`를 정확히 한 번 알린다. */
export function startMicWatch(
  bin: string,
  onEvent: (e: MicWatchEvent) => void,
  opts: MicWatchOptions = {},
): { stop(): void } {
  const child: ChildProcess = (opts.spawnFn ?? spawn)(bin, [], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const graceMs = opts.stopGraceMs ?? STOP_GRACE_MS;

  let exitedFlag = false;
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((r) => (resolveExited = r));
  const reportExit = () => {
    if (exitedFlag) return;
    exitedFlag = true;
    resolveExited();
    onEvent({ kind: "exit" });
  };
  child.once("close", reportExit);
  // spawn 실패는 'close' 없이 'error'만 올 수 있다. 리스너가 없으면 Electron main이 통째로 죽는다.
  child.once("error", reportExit);

  // 헬퍼가 죽은 뒤의 EPIPE. 리스너가 없으면 main에서 uncaught가 된다. 종료는 'close'가 알린다.
  child.stdin?.on("error", () => {});

  let buffered = "";
  child.stdout?.on("data", (b: Buffer) => {
    buffered += b.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseMicWatchLine(line.trim());
      if (event !== null) onEvent(event);
    }
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.stdin?.end();
    const term = setTimeout(() => {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
      void exited.then(() => clearTimeout(kill));
    }, graceMs);
    void exited.then(() => clearTimeout(term));
  };

  return { stop };
}
