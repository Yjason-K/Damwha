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
  child.on("exit", (exitCode) => {
    code = exitCode ?? 0;
    for (const l of listeners) l(code);
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
