import { spawn } from "child_process";
import type { ApiHandle } from "./api-process";

export interface ViteOptions {
  /** 저장소 루트 */
  cwd: string;
  /** 예: http://127.0.0.1:51734/api */
  apiBaseUrl: string;
}

/**
 * Vite는 셸 환경변수가 .env 파일을 이긴다. 그래서 API 포트가 폴백돼도 렌더러가
 * 옳은 주소를 본다 (스펙 §11).
 */
export function launchVite(options: ViteOptions): ApiHandle {
  const listeners: Array<(code: number) => void> = [];
  let code: number | null = null;
  let tail = "";
  const child = spawn("pnpm", ["--filter", "damwha-fe", "run", "dev"], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // API 자식과 같은 이유다 — 그룹 종료가 동작해야 esbuild 손자가 남지 않는다.
    detached: true,
    env: { ...process.env, VITE_API_BASE_URL: options.apiBaseUrl },
  });
  const pid = child.pid;
  child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[vite] ${b}`));
  child.stderr?.on("data", (b: Buffer) => {
    tail = (tail + b.toString()).slice(-8_000);
    process.stderr.write(`[vite!] ${b}`);
  });
  /** 종료 알림은 한 번만 나간다. 'error' 뒤에 'exit'가 또 와도 먼저 기록된 코드가 유지된다. */
  const settle = (exitCode: number) => {
    if (code !== null) return;
    code = exitCode;
    for (const l of listeners) l(exitCode);
  };
  child.on("exit", (exitCode) => {
    settle(exitCode ?? 0);
  });
  // spawn 자체가 실패하면 Node는 'exit'가 아니라 'error'를 낸다. 리스너가 없으면
  // EventEmitter가 예외를 던져 Electron main 프로세스째 죽는다 — rendererTarget이
  // 보여줄 수 있는 "Vite를 띄우지 못했어요" 화면 대신 앱이 통째로 사라진다.
  // api-process.ts가 같은 이유로 같은 처리를 한다 (pnpm이 PATH에 없거나 corepack이
  // GUI 실행 환경에서 활성화되지 않은 경우).
  child.on("error", (err: Error) => {
    tail = (tail + `spawn failed: ${err.message}\n`).slice(-8_000);
    settle(-1);
  });
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
    get pid() {
      return pid;
    },
    alive: () => code === null,
    stderrTail: () => tail,
    exitCode: () => code,
    onExit(listener) {
      if (code !== null) listener(code);
      else listeners.push(listener);
    },
    async stop(graceMs) {
      if (code !== null) return;
      killGroup("SIGTERM");
      const waitUntil = async (ms: number) => {
        const start = Date.now();
        while (code === null && Date.now() - start < ms) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await waitUntil(graceMs);
      if (code !== null) return;
      killGroup("SIGKILL");
      await waitUntil(2_000);
    },
  };
}
