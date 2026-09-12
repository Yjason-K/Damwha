import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { buildChildPath } from "./resolve";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceSpec } from "./types";

/** Task 7이 __main__.py에 넣은 줄. DB에 실제로 붙은 뒤에만 나온다. */
const READY = /supervisor \S+ ready \(db connected\)/g;
/** __main__.py:173의 백오프 경고. */
const RECONNECT_FAILED = /reconnect failed/g;

function lastIndexOfMatch(text: string, re: RegExp): number {
  let last = -1;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m.index;
  return last;
}

export function workerReady(stderr: string): boolean {
  return lastIndexOfMatch(stderr, READY) >= 0;
}

/**
 * ready 줄보다 **뒤에** reconnect 실패가 있으면 degraded다. 그 뒤에 ready가 또 나오면 회복이다 —
 * Task 7이 재접속에서도 같은 줄을 찍게 한 이유가 이것이다 (스펙 §6.6).
 */
export function workerDegraded(stderr: string): boolean {
  const ready = lastIndexOfMatch(stderr, READY);
  if (ready < 0) return false;
  return lastIndexOfMatch(stderr, RECONNECT_FAILED) > ready;
}

export interface UvLaunchOptions {
  ctx: LaunchContext;
  args: readonly string[];
  logId: "worker" | "embed";
  extraEnv?: Record<string, string>;
}

/**
 * uv를 절대 경로로 부르고, 탐색 목록을 자식 PATH 앞에 붙인다. 두 번째가 없으면 worker 안의
 * shutil.which("mlx_lm.server")와 pipeline/ffmpeg.py:24,59의 리터럴 호출이 실패한다 (스펙 §6.3).
 */
export function launchWithUv(options: UvLaunchOptions): LaunchResult {
  const { ctx, args, logId } = options;
  if (ctx.bins.uv === null) {
    throw new Error(
      "uv를 찾지 못했어요. 설치하거나 config.json의 UV_BIN에 경로를 적어 주세요.",
    );
  }
  const workerDir = path.join(ctx.repoRoot, "be", "worker");
  const logFile = ctx.logFile(logId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.createWriteStream(logFile, { flags: "a" });
  // 로그를 못 쓰는 것은 앱이 죽을 이유가 아니다 (Phase 1의 makeSink와 같은 규칙).
  out.on("error", () => undefined);

  const child = spawn(ctx.bins.uv, ["run", "--directory", workerDir, ...args], {
    cwd: workerDir,
    stdio: ["ignore", "pipe", "pipe"],
    // detached가 없으면 자식이 부모 그룹에 들어가 process.kill(-pid)가 그룹을 못 찾는다.
    detached: true,
    env: {
      ...process.env,
      ...ctx.env,
      ...options.extraEnv,
      PATH: buildChildPath(ctx.searchDirs, process.env.PATH),
    },
  });

  let tail = "";
  let code: number | null = null;
  const listeners: Array<(c: number) => void> = [];
  const settle = (c: number) => {
    if (code !== null) return;
    code = c;
    out.end();
    for (const l of listeners) {
      try {
        l(c);
      } catch {
        // 알릴 곳이 없다. 자식은 이미 죽었다.
      }
    }
  };
  const append = (b: Buffer) => {
    const text = b.toString();
    out.write(text);
    tail = (tail + text).slice(-32_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (c) => settle(c ?? 0));
  // spawn 실패는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이 통째로 죽는다.
  child.on("error", (e: Error) => {
    tail = `${tail}spawn failed: ${e.message}\n`;
    settle(-1);
  });

  const pid = child.pid;
  const killGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
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
    owned: true,
    handle: {
      get pid() {
        return pid;
      },
      alive: () => code === null,
      stderrTail: () => tail,
      exitCode: () => code,
      onExit(listener: (c: number) => void) {
        if (code !== null) listener(code);
        else listeners.push(listener);
      },
      async stop(graceMs: number) {
        if (code !== null) return;
        killGroup("SIGTERM");
        const until = Date.now() + graceMs;
        while (code === null && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    } as never,
  };
}

export interface WorkerDeps {
  /** 외부 supervisor의 pid들. Task 4의 parseWorkerProcesses가 채운다. */
  listExternal(): Promise<number[]>;
  /** worker의 .env 존재 확인. 테스트가 주입한다. */
  exists?(p: string): boolean;
  /** 종료 절차. Task 11의 stopWorker를 main.ts가 넘긴다. */
  stop?(result: LaunchResult, graceMs: number): Promise<{ stopped: boolean; leaked: number[] }>;
}

export function workerSpec(deps: WorkerDeps): ServiceSpec {
  const exists = deps.exists ?? fs.existsSync;

  return {
    id: "worker",
    dependsOn: ["postgres"],
    gate: false,
    // stderr 꼬리를 읽을 뿐이라 사실상 공짜다. ready 줄 뒤에 reconnect 실패가 나타나는
    // 순간을 잡는다 (스펙 §6.6).
    healthIntervalMs: 10_000,
    async detectExternal() {
      const pids = await deps.listExternal();
      if (pids.length === 0) return { kind: "absent" };
      // ps eww는 SIP 때문에 다른 프로세스의 env를 내주지 않는다(2026-09-12 실측).
      // 그 worker가 앱과 같은 STORAGE_ROOT를 보는지 증명할 수 없으므로 채택하지 않는다.
      return {
        kind: "stand-down",
        detail:
          `외부 worker가 실행 중이에요 (pid ${pids.join(", ")}). 앱은 자기 worker를 띄우지 않습니다. ` +
          "그 worker의 STORAGE_ROOT가 앱과 다르면 앱으로 올린 파일이 처리되지 않아요.",
      };
    },
    async launch(ctx) {
      // uv 확인이 .env 확인보다 먼저다. repoRoot는 packaged 빌드마다 다르고 실제 체크아웃이
      // 아닐 수도 있어(테스트의 "/r"처럼) .env 존재 검사가 먼저면 uv 부재와 무관하게 항상
      // ".env 없음"으로 넘어져, uv를 못 찾은 진짜 원인이 화면에 뜨지 않는다. launchWithUv도
      // 같은 검사를 하지만 그건 .env를 통과한 뒤라 이미 늦다.
      if (ctx.bins.uv === null) {
        throw new Error(
          "uv를 찾지 못했어요. 설치하거나 config.json의 UV_BIN에 경로를 적어 주세요.",
        );
      }
      const envFile = path.join(ctx.repoRoot, "be", "worker", ".env");
      if (!exists(envFile)) {
        throw new Error(
          "be/worker/.env가 없어요. be/worker/.env.example을 복사해 값을 채운 뒤 다시 시도해 주세요.",
        );
      }
      return launchWithUv({ ctx, args: ["python", "-m", "damwha_worker"], logId: "worker" });
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null) return { kind: "failed", detail: "핸들이 없어요." };
      const tail = handle.stderrTail();
      if (!handle.alive()) {
        return { kind: "failed", detail: tail.split("\n").slice(-12).join("\n").trim() };
      }
      if (workerDegraded(tail)) {
        return {
          kind: "degraded",
          detail: "데이터베이스에 연결할 수 없어 작업을 집지 못하고 있어요. DB가 뜨면 자동으로 복구됩니다.",
        };
      }
      return workerReady(tail) ? { kind: "ready" } : { kind: "not-ready" };
    },
    async stop(result, plan) {
      if (deps.stop !== undefined) return deps.stop(result, plan.graceMs);
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
