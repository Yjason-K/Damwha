import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSink, sinkTails } from "../api-process";
import { CAUSES } from "../causes";
import { exitCauseBlock } from "../stderr";
import { buildChildPath } from "./resolve";
import type {
  LaunchContext,
  LaunchResult,
  ReadinessResult,
  ServiceSpec,
  StopOutcome,
  StopPlan,
} from "./types";

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

/**
 * launchWithUv가 실제 child_process.spawn 대신 부를 함수의 모양. 테스트가 이 자리에
 * 가짜를 주입해 detached·'error' 리스너·스트림 분리를 진짜 프로세스 없이 검증한다
 * (스펙대로면 api-process.ts의 launchDev/launchPackaged처럼 이 세 가지가 가장 조용히
 * 깨지는 지점이다 — 리뷰가 실측으로 확인: detached를 지워도, 'error' 리스너를 지워도
 * 기존 179개 테스트는 전부 그대로 통과했다).
 */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface UvLaunchOptions {
  ctx: LaunchContext;
  args: readonly string[];
  logId: "worker" | "embed";
  extraEnv?: Record<string, string>;
  /** 테스트 주입용. 기본은 실제 child_process.spawn. */
  spawnFn?: SpawnFn;
}

/**
 * uv를 절대 경로로 부르고, 탐색 목록을 자식 PATH 앞에 붙인다. 두 번째가 없으면 worker 안의
 * shutil.which("mlx_lm.server")와 pipeline/ffmpeg.py:24,59의 리터럴 호출이 실패한다 (스펙 §6.3).
 */
export function launchWithUv(options: UvLaunchOptions): LaunchResult {
  const { ctx, args, logId } = options;
  if (ctx.bins.uv === null) throw new Error(CAUSES.uvMissing.text);
  const workerDir = path.join(ctx.repoRoot, "be", "worker");
  // stdout과 stderr를 하나로 합치지 않는다. worker의 ready 줄은 stderr에 나오고
  // (console.py:110, BarAwareStreamHandler(sys.stderr)), embed(uvicorn)의 접근 로그는
  // stdout에 나온다(2026-09-12 실측) — 둘을 합치면 readiness()가 읽는 stderrTail()에
  // 30초 헬스 프로브·실제 검색 요청마다 접근 로그가 섞여, 정작 죽었을 때 봐야 할
  // 트레이스백을 그 노이즈가 밀어낸다. api-process.ts가 API 런처에서 이미 겪은 문제라
  // 같은 도구(makeSink/sinkTails)로 같은 모양으로 푼다.
  const sink = makeSink(ctx.logFile(logId));
  const spawnFn = options.spawnFn ?? spawn;

  const child = spawnFn(ctx.bins.uv, ["run", "--directory", workerDir, ...args], {
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

  let code: number | null = null;
  const listeners: Array<(c: number) => void> = [];
  const settle = (c: number) => {
    if (code !== null) return;
    code = c;
    sink.close();
    for (const l of listeners) {
      try {
        l(c);
      } catch {
        // 알릴 곳이 없다. 자식은 이미 죽었다.
      }
    }
  };
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (c) => settle(c ?? 0));
  // spawn 실패는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이 통째로 죽는다.
  child.on("error", (e: Error) => {
    sink.write(`spawn failed: ${e.message}\n`, true);
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
    // as never를 지웠다 — 그 캐스트가 ServiceHandle(=ApiHandle)이 요구하는 stdoutTail()의
    // 부재를 가려 왔다. 지금은 sinkTails(sink)가 그 자리를 실제로 채우므로 다시
    // 타입 검사 대상이 된다.
    handle: {
      get pid() {
        return pid;
      },
      alive: () => code === null,
      ...sinkTails(sink),
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
    },
  };
}

export interface WorkerDeps {
  /** 외부 supervisor의 pid들. Task 4의 parseWorkerProcesses가 채운다. */
  listExternal(): Promise<number[]>;
  /** worker의 .env 존재 확인. 테스트가 주입한다. */
  exists?(p: string): boolean;
  /**
   * 종료 절차. Task 11의 stopWorkerProcess를 main.ts가 넘긴다.
   *
   * `graceMs`가 아니라 **StopPlan 전체**를 받는다. 유예 초과 대화상자를 띄우는 것은
   * `plan.onGraceExpired`이고, 그것을 여기서 넘겨주지 않으면 어댑터가 그 콜백에 닿을 길이
   * 없다 — 감독자도 그것을 부르지 않으므로(stopAll은 plan을 spec.stop에 넘기기만 한다)
   * 아무도 부르지 않는 콜백이 되어, 유예가 지나도 사람에게 묻지 않고 조용히 강제 단계를
   * 건너뛴다. 대화상자를 어댑터가 **직접** 띄우지 않는 이유도 같다: 그러면 감독자가
   * 넘겨준 것과 둘이 되어 사용자가 같은 질문을 두 번 받는다.
   */
  stop?(result: LaunchResult, plan: StopPlan): Promise<StopOutcome>;
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
      return { kind: "stand-down", detail: CAUSES.externalWorker.text(pids) };
    },
    async launch(ctx) {
      // uv 확인이 .env 확인보다 먼저다. repoRoot는 packaged 빌드마다 다르고 실제 체크아웃이
      // 아닐 수도 있어(테스트의 "/r"처럼) .env 존재 검사가 먼저면 uv 부재와 무관하게 항상
      // ".env 없음"으로 넘어져, uv를 못 찾은 진짜 원인이 화면에 뜨지 않는다. launchWithUv도
      // 같은 검사를 하지만 그건 .env를 통과한 뒤라 이미 늦다.
      if (ctx.bins.uv === null) throw new Error(CAUSES.uvMissing.text);
      const envFile = path.join(ctx.repoRoot, "be", "worker", ".env");
      if (!exists(envFile)) throw new Error(CAUSES.workerEnvMissing.text);
      return launchWithUv({ ctx, args: ["python", "-m", "damwha_worker"], logId: "worker" });
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null) return { kind: "failed", detail: CAUSES.noHandle.text };
      const tail = handle.stderrTail();
      if (!handle.alive()) {
        // 감독자의 exitedDetail과 같은 블록이다 — 줄 수만 자르면 줄바꿈 없는 한 줄이 상한 없이 화면에 오른다.
        return { kind: "failed", detail: exitCauseBlock(tail) };
      }
      if (workerDegraded(tail)) {
        // "자동으로 복구됩니다"는 shell-hints.ts의 DEGRADED_HINT가 붙인다.
        return { kind: "degraded", detail: CAUSES.workerDbUnreachable.text };
      }
      return workerReady(tail) ? { kind: "ready" } : { kind: "not-ready" };
    },
    async stop(result, plan) {
      if (deps.stop !== undefined) return deps.stop(result, plan);
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
