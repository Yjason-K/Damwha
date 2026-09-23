import * as path from "path";
import type { MigrationGateDeps, MigrationRunner } from "./migration-gate";
import { MIGRATION_STATUS_DEADLINE_MS } from "./migration-gate";
import type { ForkFn, ToolResult } from "../../process/tool-runner";
import { nodeChildEnv, type ApiEnv } from "../../config/config";

/**
 * packaged 러너 — Electron의 Node로 `Resources/api/dist/database/migrate.js`를 돌린다 (Phase 3 스펙 §6.5-1).
 * utilityProcess에서 `require.main === module`이 참이고 인자가 process.argv로 온다(2026-09-14 실측, 결과 문서 §2.4).
 *
 * electron을 값으로 import하지 않는다(api-process.ts와 같은 이유). 실제 utilityProcess는 packaged 검증이 판정한다(Task 13).
 * 테스트는 forkFn으로 자식이 받는 인자·env만 본다. dev 러너는 runTool을 주입받는다.
 *
 * **두 러너의 env는 러너가 만든다** — 부르는 쪽(main.ts)은 감독자의 ctx.env를 그대로 넘기고, 러너가 실행하는 그때
 * nodeChildEnv로 상속 env 위에 얹고 Python 전용 키(HF_TOKEN)를 뺀다 (R-6b). 마이그레이션은 토큰을 쓰지 않는다.
 * DATABASE_URL은 항상 실린다 — dev의 cwd(be/)에서 dotenv가 be/.env를 읽지만 이미 있는 값을 덮지 않는다(스펙 §6.5-1).
 */
function electronUtilityProcess() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("electron") as typeof import("electron")).utilityProcess;
}

const OUTPUT_LIMIT = 256_000;

export function forkNodeTool(
  entry: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; deadlineMs?: number; signal?: AbortSignal; forkFn?: ForkFn },
): Promise<ToolResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted === true) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    const fork: ForkFn = opts.forkFn ?? ((modulePath, argv, o) => electronUtilityProcess().fork(modulePath, argv, o));
    const child = fork(entry, [...args], { cwd: opts.cwd, stdio: "pipe", env: opts.env });
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

/** `env`는 감독자의 살아 있는 ctx.env다. 자식 env는 실행할 때 nodeChildEnv로 만든다. */
export function packagedMigrationRunner(o: { apiDir: string; env: ApiEnv; forkFn?: ForkFn }): MigrationRunner {
  const entry = path.join(o.apiDir, "dist", "database", "migrate.js");
  const base = () => ({ cwd: o.apiDir, env: nodeChildEnv(o.env), ...(o.forkFn === undefined ? {} : { forkFn: o.forkFn }) });
  return {
    status: (signal) => forkNodeTool(entry, ["--status"], { ...base(), deadlineMs: MIGRATION_STATUS_DEADLINE_MS, signal }),
    run: (signal) => forkNodeTool(entry, [], { ...base(), signal }),
  };
}

/** dev — `pnpm be:migrate`와 같은 스크립트(ts-node). cwd가 be/라 dotenv가 be/.env를 읽지만 주입한 env를 덮지 않는다. */
export function devMigrationRunner(o: { repoRoot: string; env: ApiEnv; runTool: MigrationGateDeps["runTool"] }): MigrationRunner {
  const base = ["--filter", "damwha-be", "run", "migrate"];
  return {
    status: (signal) =>
      o.runTool("pnpm", [...base, "--", "--status"], { cwd: o.repoRoot, env: nodeChildEnv(o.env), deadlineMs: MIGRATION_STATUS_DEADLINE_MS, signal }),
    // 실행에는 deadline을 두지 않는다 — 데이터 크기에 비례하고, 멈추면 종료 신호가 끝낸다.
    run: (signal) => o.runTool("pnpm", base, { cwd: o.repoRoot, env: nodeChildEnv(o.env), signal }),
  };
}
