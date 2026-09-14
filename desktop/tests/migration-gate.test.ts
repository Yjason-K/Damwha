import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceFailure } from "../src/services/failure";
import {
  backupStamp,
  devMigrationRunner,
  KEEP_BACKUPS,
  parseStatusOutput,
  runMigrationGate,
  type MigrationGateDeps,
} from "../src/services/migration-gate";
import { pgBinaries, pgLayout } from "../src/services/pg-layout";
import type { ToolOptions, ToolResult } from "../src/services/tool-runner";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gate-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
const fail = (code: number, stderr = "boom"): ToolResult => ({ code, stdout: "", stderr, timedOut: false, aborted: false });
const statusLine = (applied: number, pending: string[], unknown: string[] = []) => `${JSON.stringify({ applied, pending, unknown })}\n`;
const NOW = new Date("2026-09-14T10:15:00.000Z");

function setup(status: ToolResult, run: ToolResult = ok(statusLine(25, []))) {
  const layout = pgLayout(path.join(root, "ud"));
  const events: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const tools: Partial<Record<string, (args: readonly string[]) => ToolResult>> = {};
  const deps: MigrationGateDeps = {
    layout,
    binaries: pgBinaries("/B/postgres"),
    now: () => NOW,
    log: (l) => void events.push(`log ${l}`),
    runner: {
      status: async (signal) => {
        events.push("status");
        signals.push(signal);
        return status;
      },
      run: async (signal) => {
        events.push("run");
        signals.push(signal);
        return run;
      },
    },
    runTool: async (bin: string, args: readonly string[], opts: ToolOptions) => {
      const tool = path.basename(bin);
      events.push(tool);
      signals.push(opts.signal);
      const custom = tools[tool];
      if (custom !== undefined) return custom(args);
      if (tool === "pg_dump") {
        fs.writeFileSync(args[args.indexOf("-f") + 1], "PGDMP");
        return ok();
      }
      if (tool === "pg_restore") return ok(";\n; Archive created at …\n");
      return fail(127);
    },
  };
  return { layout, events, signals, tools, deps };
}

async function manual(p: Promise<unknown>): Promise<ServiceFailure> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ServiceFailure);
  expect((e as ServiceFailure).recovery).toBe("manual");
  return e as ServiceFailure;
}

const actions = (events: string[]) => events.filter((e) => !e.startsWith("log "));
const signal = new AbortController().signal;

describe("parseStatusOutput", () => {
  it("takes the last valid status line and ignores pnpm's banner", () => {
    const out = `\n> damwha-be@0.2.3 migrate /r/be\n> ts-node src/database/migrate.ts --status\n\n${statusLine(24, ["025_x.sql"])}`;
    expect(parseStatusOutput(out)).toEqual({ applied: 24, pending: ["025_x.sql"], unknown: [] });
  });

  it("returns null for no line, a broken line, or the wrong shape — silence is not success", () => {
    for (const bad of ["", "ok\n", "{\n", '{"applied":"24","pending":[],"unknown":[]}\n', '{"applied":24,"pending":[1],"unknown":[]}\n']) {
      expect(parseStatusOutput(bad)).toBeNull();
    }
  });
});

describe("backupStamp", () => {
  it("is a sortable UTC stamp safe for a file name", () => {
    expect(backupStamp(NOW)).toBe("20260914T101500Z");
  });
});

describe("runMigrationGate", () => {
  it("fails when the runner fails", async () => {
    const t = setup(fail(1, "Error: connect ENOENT"));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/마이그레이션 상태를 확인하지 못했어요/);
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("fails when the runner exits 0 without a status line (스펙 §10)", async () => {
    const t = setup(ok(""));
    await manual(runMigrationGate(t.deps, signal));
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("refuses unknown migrations without backing up or running anything", async () => {
    const t = setup(ok(statusLine(25, [], ["999_from_future.sql"])));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/999_from_future\.sql/);
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("does nothing when nothing is pending", async () => {
    const t = setup(ok(statusLine(24, [])));
    expect(await runMigrationGate(t.deps, signal)).toEqual({ kind: "up-to-date" });
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("applies a fresh database without a backup — there is nothing to lose", async () => {
    const all = ["001_init.sql", "002_search.sql"];
    const t = setup(ok(statusLine(0, all)), ok(statusLine(2, [])));
    expect(await runMigrationGate(t.deps, signal)).toEqual({ kind: "migrated", applied: all, backup: null });
    expect(actions(t.events)).toEqual(["status", "run"]);
  });

  it("backs up and verifies before applying to a database with data", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    const out = await runMigrationGate(t.deps, signal);
    const final = path.join(t.layout.backups, "20260914T101500Z-before-025_x.sql.dump");
    expect(out).toEqual({ kind: "migrated", applied: ["025_x.sql"], backup: final });
    expect(actions(t.events)).toEqual(["status", "pg_dump", "pg_restore", "run"]);
    expect(fs.readdirSync(t.layout.backups)).toEqual([path.basename(final)]);
    expect(t.signals.every((s) => s === signal)).toBe(true);
  });

  it("does not apply when pg_dump fails", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    t.tools.pg_dump = () => fail(1, "pg_dump: error: could not write");
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/백업을 만들지 못해/);
    expect(actions(t.events)).not.toContain("run");
  });

  it("does not apply when the dump cannot be read back, and does not keep it as a backup", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    t.tools.pg_restore = () => fail(1, "pg_restore: error: input file does not appear to be a valid archive");
    await manual(runMigrationGate(t.deps, signal));
    expect(actions(t.events)).not.toContain("run");
    expect(fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump"))).toEqual([]);
  });

  it("clears an earlier partial dump but leaves other files and symlinks alone", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    const old = path.join(t.layout.backups, "20260901T000000Z-before-024_z.sql.dump.partial");
    fs.writeFileSync(old, "half");
    fs.writeFileSync(path.join(t.layout.backups, "notes.txt"), "keep");
    const outside = path.join(root, "outside.dump.partial");
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(t.layout.backups, "20260902T000000Z-before-024_z.sql.dump.partial"));
    await runMigrationGate(t.deps, signal);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(t.layout.backups, "notes.txt"))).toBe(true);
    expect(fs.lstatSync(path.join(t.layout.backups, "20260902T000000Z-before-024_z.sql.dump.partial")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it(`keeps the newest ${KEEP_BACKUPS} backups, pruning only after a verified new one`, async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    const old = ["20260901", "20260902", "20260903", "20260904", "20260905"].map((d) => `${d}T000000Z-before-02${d.slice(-1)}_x.sql.dump`);
    for (const n of old) fs.writeFileSync(path.join(t.layout.backups, n), "PGDMP");
    await runMigrationGate(t.deps, signal);
    const left = fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump")).sort();
    expect(left).toHaveLength(KEEP_BACKUPS);
    expect(left).not.toContain(old[0]);
    expect(left).toContain("20260914T101500Z-before-025_x.sql.dump");
  });

  it("does not prune when the new backup fails", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    for (const d of ["01", "02", "03", "04", "05", "06"]) fs.writeFileSync(path.join(t.layout.backups, `202609${d}T000000Z-before-x.sql.dump`), "PGDMP");
    t.tools.pg_dump = () => fail(1);
    await manual(runMigrationGate(t.deps, signal));
    expect(fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump"))).toHaveLength(6);
  });

  it("never prunes the backup it just made, even when its stamp sorts before older ones (clock skew / stubbed now)", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    // NOW(2026-09-14)가 아래 다섯 개(2030…)보다 이르다 — 사전순 정렬에서 방금 만든 백업이 가장 앞에 온다.
    const futureOld = ["20300101", "20300102", "20300103", "20300104", "20300105"].map((d) => `${d}T000000Z-before-x.sql.dump`);
    for (const n of futureOld) fs.writeFileSync(path.join(t.layout.backups, n), "PGDMP");
    const out = await runMigrationGate(t.deps, signal);
    const final = path.join(t.layout.backups, "20260914T101500Z-before-025_x.sql.dump");
    expect(out).toEqual({ kind: "migrated", applied: ["025_x.sql"], backup: final });
    expect(fs.existsSync(final)).toBe(true);
    const left = fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump")).sort();
    expect(left).toHaveLength(KEEP_BACKUPS);
    expect(left).toContain(path.basename(final));
  });

  it("does not prune any existing backup when verification (pg_restore --list) fails — a data-deleting path", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    const old = ["01", "02", "03", "04", "05", "06"].map((d) => `202609${d}T000000Z-before-x.sql.dump`);
    for (const n of old) fs.writeFileSync(path.join(t.layout.backups, n), "PGDMP");
    t.tools.pg_restore = () => fail(1, "pg_restore: error: input file does not appear to be a valid archive");
    await manual(runMigrationGate(t.deps, signal));
    const left = fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump")).sort();
    expect(left).toEqual(old.sort());
    expect(actions(t.events)).not.toContain("run");
  });

  it("names the backup when the runner fails", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])), fail(1, "error: relation \"nope\" does not exist"));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/마이그레이션을 적용하지 못했어요/);
    expect(e.message).toContain("20260914T101500Z-before-025_x.sql.dump");
    expect(e.message).toContain("relation \"nope\" does not exist");
  });

  it("fails when the runner says it finished but something is still pending", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])), ok(statusLine(24, ["025_x.sql"])));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/여전히 적용되지 않았어요/);
  });

  it("fails when the runner exits 0 without a line after applying", async () => {
    const t = setup(ok(statusLine(0, ["001_init.sql"])), ok(""));
    await manual(runMigrationGate(t.deps, signal));
  });

  it("wraps an unexpected exception (not a tagged ServiceFailure) as manual — a bug in the gate must not become auto-retry", async () => {
    const t = setup(ok(statusLine(24, [])));
    t.deps.runner.status = async () => {
      throw new Error("boom");
    };
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/boom/);
  });
});

/**
 * migrate.ts는 pg의 DatabaseError를 `console.error(e)`로 찍는다 — 첫 줄이 원인이고, 그 뒤로 스택과
 * 20여 줄의 속성 덤프가 붙는다. dev의 pnpm은 그 뒤에 `ELIFECYCLE …`까지 더한다. describeToolFailure의
 * "꼬리 12줄"은 이 속성 덤프의 뒷부분과 ELIFECYCLE만 남기고 원인 줄을 지운다.
 */
const REALISTIC_STDERR = [
  'error: relation "meeting_x" does not exist',
  "    at ExecuteStatement (/app/node_modules/pg/lib/client.js:1:1)",
  "    at async DatabaseService.runMigrations (/app/dist/database/migrate.js:42:5)",
  "    at async main (/app/dist/database/migrate.js:88:3)",
  "{",
  "  length: 110,",
  "  severity: 'ERROR',",
  "  code: '42P01',",
  "  detail: undefined,",
  "  hint: undefined,",
  "  position: '15',",
  "  internalPosition: undefined,",
  "  internalQuery: undefined,",
  "  where: undefined,",
  "  schema: undefined,",
  "  table: undefined,",
  "  column: undefined,",
  "  dataType: undefined,",
  "  constraint: undefined,",
  "  file: 'parse_relation.c',",
  "  line: '1449',",
  "  routine: 'parserOpenTable'",
  "}",
  " ELIFECYCLE  Command failed with exit code 1.",
].join("\n");

function loggedLines(events: string[], prefix: string): string[] {
  return events.filter((e) => e.startsWith("log ")).map((e) => e.slice(4)).filter((l) => l.startsWith(prefix));
}

describe("runner 실패의 원인 줄과 전체 로그 (스펙 §6.5-4)", () => {
  it("run 실패: 꼬리 12줄이 아니라 서두의 진짜 원인을 보여주고, stderr 전체를 로그에 남긴다", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])), fail(1, REALISTIC_STDERR));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/마이그레이션을 적용하지 못했어요/);
    expect(e.message).toContain('relation "meeting_x" does not exist');
    expect(e.message).toContain("20260914T101500Z-before-025_x.sql.dump");
    expect(e.message).not.toContain("routine: 'parserOpenTable'");
    const expected = REALISTIC_STDERR.split("\n").map((l) => `마이그레이션 러너 stderr: ${l}`);
    expect(loggedLines(t.events, "마이그레이션 러너 stderr: ")).toEqual(expected);
  });

  it("status 실패: 같은 원인 줄을 보여주고, stderr 전체를 로그에 남긴다", async () => {
    const t = setup(fail(1, REALISTIC_STDERR));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/마이그레이션 상태를 확인하지 못했어요/);
    expect(e.message).toContain('relation "meeting_x" does not exist');
    const expected = REALISTIC_STDERR.split("\n").map((l) => `마이그레이션 러너 stderr: ${l}`);
    expect(loggedLines(t.events, "마이그레이션 러너 stderr: ")).toEqual(expected);
  });

  it("로그는 스트림마다 400줄로 자르고 생략된 줄 수를 남긴다", async () => {
    const big = Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n");
    const t = setup(ok(statusLine(24, ["025_x.sql"])), fail(1, big));
    await manual(runMigrationGate(t.deps, signal));
    const logged = loggedLines(t.events, "마이그레이션 러너 stderr: ");
    expect(logged).toHaveLength(401);
    expect(logged[399]).toBe("마이그레이션 러너 stderr: line 399");
    expect(logged[400]).toMatch(/50줄 더 생략/);
  });
});

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
