import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { UtilityProcess } from "electron";
import type { ApiEnv } from "./config";

/**
 * electron을 모듈 최상단에서 값으로 import하지 않는다. 그러면 이 파일을 평범한 Node에서
 * 부를 수 없고, launchDev의 프로세스 그룹 종료를 Electron 밖에서 검증할 수 없다.
 * 타입만 최상단에서 가져오고 값은 쓰는 자리에서 받는다.
 */
function electronUtilityProcess() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("electron") as typeof import("electron")).utilityProcess;
}

export interface ApiHandle {
  readonly pid: number | undefined;
  alive(): boolean;
  /** 실패 화면에 올릴 stderr 꼬리. 사람이 읽을 마지막 줄이 여기서 나온다. */
  stderrTail(): string;
  exitCode(): number | null;
  /**
   * 종료 알림. ready 뒤에 죽는 경우를 화면에 알리려면 이게 있어야 한다 (스펙 §8).
   * 이미 죽은 뒤에 등록해도 즉시 호출된다 — 등록과 종료의 경쟁을 없앤다.
   */
  onExit(listener: (code: number) => void): void;
  stop(graceMs: number): Promise<void>;
}

export interface LaunchOptions {
  /** packaged면 Resources/api/dist/main.js. dev에서는 쓰이지 않는다. */
  entry: string;
  cwd: string;
  env: ApiEnv;
  /** 있으면 stdout·stderr를 여기에도 쓴다. */
  logFile?: string;
}

const TAIL_LIMIT = 8_000;

function makeSink(logFile?: string) {
  let tail = "";
  let out: fs.WriteStream | undefined;
  if (logFile !== undefined) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.createWriteStream(logFile, { flags: "a" });
  }
  return {
    write(chunk: Buffer | string, isError: boolean) {
      const text = chunk.toString();
      out?.write(text);
      if (isError) tail = (tail + text).slice(-TAIL_LIMIT);
    },
    tail: () => tail,
    close: () => out?.end(),
  };
}

/** 종료 알림을 모으는 작은 상자. 이미 종료된 뒤 등록해도 즉시 부른다. */
function exitNotifier() {
  const listeners: Array<(code: number) => void> = [];
  let code: number | null = null;
  return {
    settle(exitCode: number) {
      if (code !== null) return;
      code = exitCode;
      for (const l of listeners) l(exitCode);
    },
    add(listener: (code: number) => void) {
      if (code !== null) listener(code);
      else listeners.push(listener);
    },
    code: () => code,
  };
}

/**
 * SIGTERM으로 안 죽으면 SIGKILL. utilityProcess.kill()에는 신호 인자가 없다.
 * SIGKILL 뒤에도 유한 시간만 기다린다 — 무한 대기는 종료를 막는다.
 */
async function escalate(
  kill: (signal: NodeJS.Signals) => void,
  exited: () => boolean,
  graceMs: number,
): Promise<void> {
  const waitUntil = async (ms: number) => {
    const start = Date.now();
    while (!exited() && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitUntil(graceMs);
  if (exited()) return;
  kill("SIGKILL");
  await waitUntil(2_000);
}

export function launchPackaged(options: LaunchOptions): ApiHandle {
  const sink = makeSink(options.logFile);
  const exit = exitNotifier();
  // utilityProcess는 app.whenReady() 뒤에만 부를 수 있다. main.ts가 그 순서를 지킨다.
  const child: UtilityProcess = electronUtilityProcess().fork(options.entry, [], {
    cwd: options.cwd,
    stdio: "pipe",
    // HOST가 options.env 뒤에 와야 config.json 한 줄로 LAN에 열리지 않는다.
    env: { ...options.env, HOST: "127.0.0.1" },
  });
  const pid = child.pid;
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (exitCode: number) => {
    sink.close();
    exit.settle(exitCode);
  });
  return {
    get pid() {
      return pid;
    },
    alive: () => exit.code() === null,
    stderrTail: sink.tail,
    exitCode: exit.code,
    onExit: exit.add,
    async stop(graceMs) {
      if (exit.code() !== null) return;
      child.kill();
      await escalate(
        (signal) => {
          if (pid === undefined) return;
          try {
            process.kill(pid, signal);
          } catch {
            // 이미 죽었으면 ESRCH — 무시한다.
          }
        },
        () => exit.code() !== null,
        graceMs,
      );
    },
  };
}

/**
 * 개발에서는 nest start --watch를 쓴다 — 모듈이 아니라 CLI라 utilityProcess로 못 띄운다.
 * cwd는 pnpm --filter가 be/로 맞춰 주므로 be/.env가 오늘처럼 읽힌다 (스펙 §6.3).
 */
export function launchDev(options: LaunchOptions): ApiHandle {
  const sink = makeSink(options.logFile);
  const exit = exitNotifier();
  const child: ChildProcess = spawn("pnpm", ["--filter", "damwha-be", "run", "dev"], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // 필수다. detached가 없으면 자식이 부모의 프로세스 그룹에 들어가 process.kill(-pid)가
    // 그룹을 못 찾고, pnpm만 죽어 nest가 만든 손자 API가 남는다.
    detached: true,
    env: { ...process.env, ...options.env, HOST: "127.0.0.1" },
  });
  const pid = child.pid;
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (exitCode) => {
    sink.close();
    exit.settle(exitCode ?? 0);
  });
  const killGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      // 음수 pid = 프로세스 그룹 전체. detached로 만들었으므로 pid가 그룹 리더다.
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 이미 죽었다.
      }
    }
  };
  return {
    get pid() {
      return pid;
    },
    alive: () => exit.code() === null,
    stderrTail: sink.tail,
    exitCode: exit.code,
    onExit: exit.add,
    async stop(graceMs) {
      if (exit.code() !== null) return;
      killGroup("SIGTERM");
      await escalate(killGroup, () => exit.code() !== null, graceMs);
    },
  };
}
