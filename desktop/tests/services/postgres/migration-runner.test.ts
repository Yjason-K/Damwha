import { describe, expect, it } from "vitest";
import { devMigrationRunner } from "../../../src/services/postgres/migration-runner";
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
