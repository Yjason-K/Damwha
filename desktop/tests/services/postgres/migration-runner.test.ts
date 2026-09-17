import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { devMigrationRunner, packagedMigrationRunner } from "../../../src/services/postgres/migration-runner";
import type { ToolOptions, ToolResult } from "../../../src/process/tool-runner";

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
const signal = new AbortController().signal;

describe("devMigrationRunner", () => {
  it("runs the same script as `pnpm be:migrate`, with a deadline only on --status", async () => {
    const calls: Array<{ bin: string; args: readonly string[]; opts: ToolOptions }> = [];
    const r = devMigrationRunner({
      repoRoot: "/r",
      env: { DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fx" },
      runTool: async (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return ok();
      },
    });
    await r.status(signal);
    await r.run(signal);
    expect(calls[0]).toMatchObject({ bin: "pnpm", args: ["--filter", "damwha-be", "run", "migrate", "--", "--status"] });
    expect(calls[0].opts).toMatchObject({ cwd: "/r", deadlineMs: 60_000, signal });
    expect(calls[1].args).toEqual(["--filter", "damwha-be", "run", "migrate"]);
    expect(calls[1].opts.deadlineMs).toBeUndefined();
    expect(calls[1].opts.env.DATABASE_URL).toContain("host=");
  });
});

describe("migration runners — HF_TOKEN stays with the Python children (R-6b)", () => {
  /**
   * 러너는 main.ts가 넘기는 감독자의 ctx.env를 받아 스스로 Node 자식 env(nodeChildEnv)를 만든다 — 상속 env 위에 얹고
   * Python 전용 키를 뺀다. 마이그레이션은 토큰을 쓰지 않는다.
   */
  const TOKEN = "hf_KeychainTokenValue0123456789abcd";
  const live = { HF_TOKEN: TOKEN, DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu%2Frun" };

  it("dev: pnpm gets the live env and the inherited one, without HF_TOKEN", async () => {
    vi.stubEnv("HF_TOKEN", "hf_fromTheDeveloperShell000000000");
    try {
      const envs: Array<Record<string, string>> = [];
      const r = devMigrationRunner({
        repoRoot: "/r",
        env: live,
        runTool: async (_bin, _args, opts) => {
          envs.push(opts.env);
          return ok();
        },
      });
      await r.status(signal);
      await r.run(signal);
      expect(envs).toHaveLength(2);
      for (const env of envs) {
        expect("HF_TOKEN" in env).toBe(false);
        expect(env.DATABASE_URL).toBe(live.DATABASE_URL);
        expect(env.PATH).toBe(process.env.PATH);
      }
      expect(live.HF_TOKEN).toBe(TOKEN);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("dev: reads the live env when it runs, not when it was made", async () => {
    const envs: Array<Record<string, string>> = [];
    const env: Record<string, string> = { DATABASE_URL: "a" };
    const r = devMigrationRunner({ repoRoot: "/r", env, runTool: async (_b, _a, opts) => (envs.push(opts.env), ok()) });
    env.DATABASE_URL = "b";
    await r.status(signal);
    expect(envs[0].DATABASE_URL).toBe("b");
  });

  it("packaged: the forked migrate.js gets the live env and the inherited one, without HF_TOKEN", async () => {
    vi.stubEnv("HF_TOKEN", "hf_fromTheDeveloperShell000000000");
    try {
      const seen: Array<Electron.ForkOptions | undefined> = [];
      const r = packagedMigrationRunner({
        apiDir: "/app/Resources/api",
        env: live,
        forkFn: (modulePath, args, opts) => {
          seen.push(opts);
          expect(modulePath).toBe("/app/Resources/api/dist/database/migrate.js");
          const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
          setTimeout(() => child.emit("exit", 0), 0);
          void args;
          return child as unknown as Electron.UtilityProcess;
        },
      });
      await expect(r.status(signal)).resolves.toMatchObject({ code: 0 });
      await expect(r.run(signal)).resolves.toMatchObject({ code: 0 });
      expect(seen).toHaveLength(2);
      for (const opts of seen) {
        const env = (opts?.env ?? {}) as Record<string, string | undefined>;
        expect("HF_TOKEN" in env).toBe(false);
        expect(env.DATABASE_URL).toBe(live.DATABASE_URL);
        expect(env.PATH).toBe(process.env.PATH);
        expect(opts?.cwd).toBe("/app/Resources/api");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
