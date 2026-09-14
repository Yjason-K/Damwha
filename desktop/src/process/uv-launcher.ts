import { spawn } from "child_process";
import * as path from "path";
import { CAUSES } from "../diagnostics/causes";
import type { LaunchContext, LaunchResult } from "../services/types";
import { buildChildPath } from "./executables";
import { makeSink, sinkTails } from "./output";
import type { SpawnFn } from "./tool-runner";

export interface UvLaunchOptions {
  ctx: LaunchContext;
  args: readonly string[];
  logId: "worker" | "embed";
  extraEnv?: Record<string, string>;
  /**
   * launchWithUv가 실제 child_process.spawn 대신 부를 함수의 모양. 테스트가 이 자리에
   * 가짜를 주입해 detached·'error' 리스너·스트림 분리를 진짜 프로세스 없이 검증한다
   * (스펙대로면 api-process.ts의 launchDev/launchPackaged처럼 이 세 가지가 가장 조용히
   * 깨지는 지점이다 — 리뷰가 실측으로 확인: detached를 지워도, 'error' 리스너를 지워도
   * 기존 179개 테스트는 전부 그대로 통과했다).
   * 기본은 실제 child_process.spawn.
   */
  spawnFn?: SpawnFn;
  /** stderr 청크를 싱크와 같은 순서로 받는다. worker의 ReadinessWatch가 여기 붙는다. */
  onStderr?: (text: string) => void;
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
    // 자기 프로세스 그룹을 갖게 한다. 종료 신호는 이제 그룹이 아니라 uv의 pid로 보내므로(아래
    // signalUv) 그 이유는 아니다 — 없으면 uv와 Python이 **Electron의** 그룹에 들어가, dev 터미널의
    // Ctrl-C 같은 그룹 신호가 우리 종료 절차(§6.9)를 거치지 않고 둘에게 곧바로 닿는다.
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
  child.stderr?.on("data", (b: Buffer) => {
    sink.write(b, true);
    options.onStderr?.(b.toString());
  });
  child.on("exit", (c) => settle(c ?? 0));
  // spawn 실패는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이 통째로 죽는다.
  child.on("error", (e: Error) => {
    sink.write(`spawn failed: ${e.message}\n`, true);
    settle(-1);
  });

  const pid = child.pid;
  /**
   * **uv의 pid로 보낸다, 그룹이 아니라.** `uv run`은 받은 SIGTERM을 자식에게 한 번씩 전달하고, 그
   * 자식은 uv와 같은 그룹이라 그룹 신호는 커널이 한 번 더 배달한다 — 자식이 두 번 받는다.
   * 2026-09-13 실측(스크래치 toy): uv 아래 uvicorn 0.49.0에 그룹 SIGTERM 1회 → `handle_exit` 2회
   * (2/2), uv pid 1회 → 1회(1/1). worker supervisor에서는 그 두 번째가 강제 종료다(worker-shutdown.ts
   * 1단계). embed(uvicorn)는 두 번째 SIGTERM을 강제로 읽지 않아(SIGINT만 그렇다) 진행 중인 요청이
   * 끝까지 나갔지만, 그것은 uvicorn 구현 한 줄(`sig == SIGINT`)에 기댄 우연이다. 한 런처가 두
   * 서비스에 같은 규칙을 쓴다. embed에서 그룹이라서만 닿는 것도 없다: 그 그룹에는 uv와 uvicorn
   * Python뿐이다(bge-m3는 프로세스 안에서 올라온다). 프로덕션 worker는 이 경로가 아니라 main.ts의
   * stopOwnWorker → worker-shutdown.ts로 내린다 — 그쪽에 남는 차이(같은 그룹의 capabilities 프로브)는
   * 스펙 §6.9에 적었다.
   */
  const signalUv = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(pid, signal);
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
    // as never를 지웠다 — 그 캐스트가 ServiceHandle(=ProcessHandle)이 요구하는 stdoutTail()의
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
        signalUv("SIGTERM");
        const until = Date.now() + graceMs;
        while (code === null && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    },
  };
}
