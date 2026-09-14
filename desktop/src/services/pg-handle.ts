import { execFile, spawn } from "child_process";
import { makeSink, sinkTails } from "../api-process";
import { pgToolEnv, PG_SOCKET_PORT, type PgBinaries, type PgLayout } from "./pg-layout";
import type { ProcessInfo } from "./pg-pidfile";
import type { SpawnFn } from "./tool-runner";
import type { ServiceHandle } from "./types";

/**
 * postmaster의 프로세스 수준 (Phase 3 스펙 §6.4 "핸들"·"종료").
 *
 * Phase 1·2의 launchDev/launchPackaged 핸들을 쓰지 않는다. 그 stop()은 유예를 넘기면 끝을 보장하려고 더 센 신호로
 * 올라가고(api-process.ts의 escalate), dev 런처는 프로세스 그룹 전체에 신호를 보낸다. postmaster에는 둘 다 금지다 —
 * 백엔드 자식과 공유 메모리를 남기고, 자식에게 신호를 전달하는 것은 postmaster 자신의 일이다. 그래서 이 파일의 신호
 * 타입에는 SIGINT(fast)와 SIGQUIT(immediate)만 있다.
 */

export type PostmasterSignal = "SIGINT" | "SIGQUIT";
export type PostmasterStopResult = "fast" | "immediate" | "leaked";

export interface PostmasterStopDeps {
  signal(pid: number, sig: PostmasterSignal): void;
  alive(): boolean;
  pollMs?: number;
}

export async function stopPostmaster(
  pid: number | undefined,
  fastGraceMs: number,
  immediateGraceMs: number,
  deps: PostmasterStopDeps,
): Promise<PostmasterStopResult> {
  if (!deps.alive()) return "fast";
  // 믿을 수 없는 pid에는 신호를 보내지 않는다. process.kill(0, …)은 우리 프로세스 그룹 전체다.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return "leaked";
  const pollMs = deps.pollMs ?? 100;
  const gone = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (deps.alive() && Date.now() < until) await new Promise((r) => setTimeout(r, pollMs));
    return !deps.alive();
  };
  deps.signal(pid, "SIGINT");
  if (await gone(fastGraceMs)) return "fast";
  // immediate도 커밋된 데이터는 WAL로 보존한다. 다음 기동이 crash recovery를 한다.
  deps.signal(pid, "SIGQUIT");
  if (await gone(immediateGraceMs)) return "immediate";
  return "leaked";
}

export function postmasterArgs(layout: PgLayout): string[] {
  const c = (setting: string) => ["-c", setting];
  return [
    "-D",
    layout.pgdata,
    // TCP를 열지 않는다. Docker의 5432·Homebrew PostgreSQL과 포트가 부딪힐 수 없게 구조로 막는다 (스펙 §6.3).
    ...c("listen_addresses="),
    ...c(`unix_socket_directories=${layout.runDir}`),
    ...c("unix_socket_permissions=0700"),
    ...c(`port=${PG_SOCKET_PORT}`),
    // 서버 로그를 앱의 파이프가 아니라 서버가 직접 파일에 쓰게 한다. 앱이 죽어 고아가 된 서버의 기록도 남는다.
    ...c("logging_collector=on"),
    ...c(`log_directory=${layout.logDir}`),
    ...c("log_filename=postgres-%a.log"),
    ...c("log_rotation_age=1d"),
    ...c("log_rotation_size=10MB"),
    ...c("log_truncate_on_rotation=on"),
  ];
}

export interface PostmasterLaunch {
  binaries: PgBinaries;
  layout: PgLayout;
  /** 수집기가 뜨기 전의 초기 오류(권한·락·설정)가 stderr로 온다. 그것을 받는 파일. */
  logFile: string;
  immediateGraceMs: number;
  spawnFn?: SpawnFn;
}

export function spawnPostmaster(o: PostmasterLaunch): ServiceHandle {
  const sink = makeSink(o.logFile);
  // pg_ctl start를 쓰지 않는다 — 내부의 /bin/sh -c "exec postgres … 2>&1 &"가 서버 stderr를 합친다 (Phase 0 규칙 2b).
  // 자기 프로세스 그룹으로 띄운다: 없으면 dev 터미널의 Ctrl-C가 종료 순서(worker → embed → api → postgres)를 건너뛰고
  // postmaster에 먼저 닿는다.
  const child = (o.spawnFn ?? spawn)(o.binaries.postgres, postmasterArgs(o.layout), {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: pgToolEnv(),
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
  child.on("exit", (c: number | null) => settle(c ?? 1));
  child.on("error", (e: Error) => {
    sink.write(`spawn failed: ${e.message}\n`, true);
    settle(-1);
  });
  const pid = child.pid;
  const signal = (p: number, sig: PostmasterSignal) => {
    try {
      process.kill(p, sig);
    } catch {
      // 이미 죽었다(ESRCH).
    }
  };
  return {
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
      await stopPostmaster(pid, graceMs, o.immediateGraceMs, { signal, alive: () => code === null });
    },
  };
}

/** 그 pid가 살아 있나. 신호 0은 존재만 묻는다. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM은 "있는데 우리 것이 아니다"다.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps -o comm=`·`-o args=`. 그 pid가 없으면 null, ps 자체가 실패하면 던진다 — 락 판정은 그것을 "증명 불가"로 읽는다. */
export async function psInfo(pid: number): Promise<ProcessInfo | null> {
  const field = (name: "comm" | "args") =>
    new Promise<string | null>((resolve, reject) => {
      execFile("/bin/ps", ["-o", `${name}=`, "-p", String(pid)], { timeout: 2_000 }, (err, stdout) => {
        if (err === null) {
          resolve(stdout.trim());
          return;
        }
        // ps는 그 pid가 없으면 exit 1에 빈 출력이다. 그것은 "없다"이지 실패가 아니다.
        if ((err as { code?: unknown }).code === 1 && stdout.trim() === "") {
          resolve(null);
          return;
        }
        reject(err);
      });
    });
  const comm = await field("comm");
  if (comm === null) return null;
  const args = await field("args");
  return args === null ? null : { comm, args };
}

/** 이전 실행이 남긴 postmaster(우리 자식이 아니다)를 내린다. */
export function stopOrphanPostmaster(pid: number, fastGraceMs: number, immediateGraceMs: number): Promise<PostmasterStopResult> {
  return stopPostmaster(pid, fastGraceMs, immediateGraceMs, {
    signal: (p, sig) => {
      try {
        process.kill(p, sig);
      } catch {
        // 이미 죽었다.
      }
    },
    alive: () => processExists(pid),
  });
}
