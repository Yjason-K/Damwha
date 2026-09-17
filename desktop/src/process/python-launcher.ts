import { spawn } from "child_process";
import * as path from "path";
import { childEnv } from "../config/config";
import type { LaunchContext, LaunchResult } from "../services/types";
import { makeSink, sinkTails } from "./output";
import type { SpawnFn } from "./tool-runner";

export interface PythonLaunchOptions {
  ctx: LaunchContext;
  /** `-m` 뒤의 모듈. `"damwha_worker"` | `"damwha_worker.embed_service"`. */
  module: string;
  /** 모듈 뒤에 붙는 인자. `--run-id`는 런처가 **맨 뒤에** 붙인다. */
  args?: readonly string[];
  logId: "worker" | "embed";
  /**
   * 실제 child_process.spawn 대신 부를 함수. 테스트가 가짜를 주입해 detached·'error' 리스너·스트림
   * 분리를 진짜 프로세스 없이 검증한다 — 이 셋이 가장 조용히 깨지는 지점이다(Phase 2 리뷰 실측:
   * detached를 지워도, 'error' 리스너를 지워도 당시 테스트 전부가 그대로 통과했다). 기본은 실제 spawn.
   */
  spawnFn?: SpawnFn;
  /** stderr 청크를 싱크와 같은 순서로 받는다. worker의 ReadinessWatch가 여기 붙는다. */
  onStderr?: (text: string) => void;
}

/**
 * 번들 경로가 쓸 수 있는 모양인지. 절대 경로가 아니면 spawn이 cwd(userData) 기준으로 풀어 엉뚱한 파일을
 * 찾거나, PATH에 상대 조각이 들어간다. main.ts는 항상 절대 경로를 만들므로 이 검사가 걸리면 배선 결함이다.
 */
function requireAbsolute(what: string, value: string, logId: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${what} 경로가 절대 경로가 아니라 ${logId}를 띄우지 않았어요: ${JSON.stringify(value)}`);
  }
}

/**
 * 번들 Python으로 worker·embed를 띄운다 (Phase 4 스펙 §6.2).
 *
 * ```
 * <python>/bin/python3.12 -m <module> [args…] --run-id=<runId>
 * ```
 *
 * - **`-m` 진입만 쓴다.** 콘솔 스크립트는 셔뱅을 타고, 옛 경로가 남아 있으면 죽지 않고 조용히 다른 런타임을
 *   실행한다(Phase 0 R-6). 인터프리터는 `bin/python3.12` 실체다 — `python`·`python3` 링크로 띄우면 argv[0]이
 *   링크 이름으로 남아 §6.5 조건 1(basename `python3.12`)에서 빠진다.
 * - **`--run-id`는 맨 뒤다.** 앱이 ps로 자기 자식을 알아보는 표식이다(§6.5). worker는 이것을 `--once`
 *   자식과 llm_entry에 그대로 넘기고, embed는 읽지 않는다(uvicorn.run은 argv를 보지 않는다).
 * - **env는 `childEnv(ctx)` 하나로 만든다.** 합성 규칙(합친 뒤 씻고, 앱 값을 그 뒤에 얹는다)의 유일한
 *   구현이다 — 여기서 다시 짜면 순서가 갈린다. 그 위에 PATH만 얹는다.
 * - **PATH는 `<python>/bin:<ffmpeg>/bin`뿐이다.** 상속 PATH도 `ctx.searchDirs`도 주지 않는다 — Homebrew
 *   ffmpeg가 조용히 쓰여도 검증이 통과하는 폴백을 구조적으로 없앤다. 없는 도구는 시끄럽게 죽는다.
 * - **cwd는 userData다.** 저장소 체크아웃이 더는 없다. worker는 경로를 절대값으로 받으므로 cwd에 기대지
 *   않는다. Settings가 cwd의 `.env`를 읽지만 앱은 그 파일을 만들지 않는다(main.ts가 있으면 알린다).
 */
export function launchPython(options: PythonLaunchOptions): LaunchResult {
  const { ctx, module, logId } = options;
  const python = ctx.bins.python;
  requireAbsolute("번들 Python", python, logId);
  requireAbsolute("번들 ffmpeg", ctx.bins.ffmpeg, logId);
  // 싱크를 열기 전에 env를 만든다 — dev인데 저장소가 없으면 childEnv가 던지고, 그때 열린 로그 스트림이 남지 않게.
  const env = {
    ...childEnv(ctx),
    PATH: [path.dirname(python), path.dirname(ctx.bins.ffmpeg)].join(":"),
  };
  const argv = ["-m", module, ...(options.args ?? []), `--run-id=${ctx.runId}`];

  // stdout과 stderr를 하나로 합치지 않는다. worker의 ready 줄은 stderr에 나오고
  // (console.py의 BarAwareStreamHandler(sys.stderr)), embed(uvicorn)의 접근 로그는 stdout에 나온다
  // (2026-09-12 실측) — 둘을 합치면 readiness()가 읽는 stderrTail()에 30초 헬스 프로브·실제 검색 요청마다
  // 접근 로그가 섞여, 정작 죽었을 때 봐야 할 트레이스백을 그 노이즈가 밀어낸다.
  const sink = makeSink(ctx.logFile(logId));
  const spawnFn = options.spawnFn ?? spawn;

  let child: ReturnType<SpawnFn>;
  try {
    child = spawnFn(python, argv, {
      cwd: ctx.userData,
      stdio: ["ignore", "pipe", "pipe"],
      // 자기 세션·그룹을 갖게 한다(python이 그룹 리더, pgid = pid). 없으면 python이 **Electron의** 그룹에
      // 들어가, dev 터미널의 Ctrl-C 같은 그룹 신호가 우리 종료 절차를 거치지 않고 곧바로 닿는다.
      // worker-shutdown.ts는 supervisor가 끝난 뒤 이 그룹(-pid)에 SIGTERM을 보내 capabilities 프로브를 거둔다.
      detached: true,
      env,
    });
  } catch (e) {
    // 동기 실패(인자 형식 오류 등)는 'error' 이벤트로 오지 않는다. 열어 둔 로그 스트림을 닫고 그대로 던진다.
    sink.close();
    throw e;
  }

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
  // spawn 실패(번들 python이 없다 → ENOENT)는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이
  // 통째로 죽는다. 싱크에 적은 문구를 감독자가 죽은 핸들의 꼬리에서 원인으로 올린다(causes.ts의 spawnNotFound).
  child.on("error", (e: Error) => {
    sink.write(`spawn failed: ${e.message}\n`, true);
    settle(-1);
  });

  const pid = child.pid;
  /**
   * **python의 pid로 직접 보낸다.** 중간 전달자가 없으므로 보낸 수가 곧 받는 수다 — worker supervisor의
   * `_on_signal`은 받은 수를 세어 두 번째를 강제로 읽는다. 그룹(-pid)이 아닌 이유: worker의 그룹에는
   * supervisor가 세션 분리 없이 띄운 capabilities 프로브가 함께 있고, 그것을 거두는 자리는 supervisor가 끝난
   * 뒤의 worker-shutdown.ts 한 곳이다. embed의 그룹에는 uvicorn python 하나뿐이라 어느 쪽이든 같다 — 한
   * 런처가 두 서비스에 같은 규칙을 쓴다. 프로덕션 worker는 이 경로가 아니라 main.ts의 stopOwnWorker →
   * worker-shutdown.ts로 내린다.
   */
  const signalPython = (signal: NodeJS.Signals) => {
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
        signalPython("SIGTERM");
        const until = Date.now() + graceMs;
        while (code === null && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    },
  };
}
