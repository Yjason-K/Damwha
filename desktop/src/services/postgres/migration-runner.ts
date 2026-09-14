import * as path from "path";
import type { MigrationGateDeps, MigrationRunner } from "./migration-gate";
import { MIGRATION_STATUS_DEADLINE_MS } from "./migration-gate";
import type { ToolResult } from "../../process/tool-runner";

/**
 * packaged 러너 — Electron의 Node로 `Resources/api/dist/database/migrate.js`를 돌린다 (Phase 3 스펙 §6.5-1).
 * utilityProcess에서 `require.main === module`이 참이고 인자가 process.argv로 온다(2026-09-14 실측, 결과 문서 §2.4).
 *
 * electron을 값으로 import하지 않는다(api-process.ts와 같은 이유). forkNodeTool·packaged 러너는 vitest가 부르지 않는다 — packaged
 * 검증이 판정한다(Task 13). dev 러너는 runTool을 주입받으므로 테스트가 부른다.
 */
function electronUtilityProcess() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("electron") as typeof import("electron")).utilityProcess;
}

const OUTPUT_LIMIT = 256_000;

export function forkNodeTool(
  entry: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; deadlineMs?: number; signal?: AbortSignal },
): Promise<ToolResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted === true) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    const child = electronUtilityProcess().fork(entry, [...args], { cwd: opts.cwd, stdio: "pipe", env: opts.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const terminate = () => {
      try {
        child.kill();
      } catch {
        // 이미 끝났다.
      }
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    child.stdout?.on("data", (b: Buffer) => {
      stdout = (stdout + b.toString()).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-OUTPUT_LIMIT);
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.deadlineMs);
    }
    child.on("error", (type, location) => {
      spawnError = `${type} ${location}`;
    });
    child.on("exit", (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, ...(spawnError === undefined ? {} : { spawnError }) });
    });
  });
}

export function packagedMigrationRunner(o: { apiDir: string; env: Record<string, string> }): MigrationRunner {
  const entry = path.join(o.apiDir, "dist", "database", "migrate.js");
  return {
    status: (signal) => forkNodeTool(entry, ["--status"], { cwd: o.apiDir, env: o.env, deadlineMs: MIGRATION_STATUS_DEADLINE_MS, signal }),
    run: (signal) => forkNodeTool(entry, [], { cwd: o.apiDir, env: o.env, signal }),
  };
}

/** dev — `pnpm be:migrate`와 같은 스크립트(ts-node). cwd가 be/라 dotenv가 be/.env를 읽지만 주입한 env를 덮지 않는다. */
export function devMigrationRunner(o: { repoRoot: string; env: Record<string, string>; runTool: MigrationGateDeps["runTool"] }): MigrationRunner {
  const base = ["--filter", "damwha-be", "run", "migrate"];
  return {
    status: (signal) => o.runTool("pnpm", [...base, "--", "--status"], { cwd: o.repoRoot, env: o.env, deadlineMs: MIGRATION_STATUS_DEADLINE_MS, signal }),
    // 실행에는 deadline을 두지 않는다 — 데이터 크기에 비례하고, 멈추면 종료 신호가 끝낸다.
    run: (signal) => o.runTool("pnpm", base, { cwd: o.repoRoot, env: o.env, signal }),
  };
}
