import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceFailure } from "../src/services/failure";
import { pgBinaries, pgLayout, PG_BINARY_NAMES, type PgLayout } from "../src/services/pg-layout";
import { parseMarker, serializeMarker } from "../src/services/pg-pairing";
import {
  embeddedPostgresSpec,
  externalPostgresSpec,
  PG_FAST_GRACE_MS,
  type EmbeddedPostgresDeps,
} from "../src/services/pg-service";
import type { ToolResult } from "../src/services/tool-runner";
import type { LaunchContext, LaunchResult, ServiceHandle } from "../src/services/types";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pgsvc-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
const fail = (code: number, stderr = "boom"): ToolResult => ({ code, stdout: "", stderr, timedOut: false, aborted: false });

type FakeHandle = ServiceHandle & { markReady(status?: string): void; stops: number[]; die(): void };

function fakeHandle(layout: PgLayout, pid = 5151): FakeHandle {
  let alive = true;
  const stops: number[] = [];
  return {
    pid,
    alive: () => alive,
    stderrTail: () => "",
    stdoutTail: () => "",
    exitCode: () => (alive ? null : 1),
    onExit: () => undefined,
    async stop(graceMs: number) {
      stops.push(graceMs);
    },
    stops,
    die() {
      alive = false;
    },
    markReady(status = "ready   ") {
      fs.writeFileSync(
        path.join(layout.pgdata, "postmaster.pid"),
        [String(pid), layout.pgdata, "0", "5432", layout.runDir, "", "", status, ""].join("\n"),
      );
      fs.mkdirSync(layout.runDir, { recursive: true });
      fs.writeFileSync(layout.socketFile, "");
    },
  };
}

function setup(over: Partial<EmbeddedPostgresDeps> = {}) {
  const layout = pgLayout(path.join(root, "ud"));
  const bundleDir = path.join(root, "bundle");
  fs.mkdirSync(path.join(bundleDir, "bin"), { recursive: true });
  for (const n of PG_BINARY_NAMES) {
    const f = path.join(bundleDir, "bin", n);
    fs.writeFileSync(f, "#!/bin/sh\n");
    fs.chmodSync(f, 0o755);
  }
  const world = {
    clusterId: "7412345678901234567",
    oid: null as number | null,
    calls: [] as Array<{ tool: string; args: readonly string[]; signal?: AbortSignal }>,
    override: {} as Partial<Record<string, (args: readonly string[]) => ToolResult>>,
  };
  const log: string[] = [];
  const handles: FakeHandle[] = [];
  const orphans: number[] = [];
  const deps: EmbeddedPostgresDeps = {
    binaries: pgBinaries(bundleDir),
    layout,
    log: (l) => void log.push(l),
    runTool: async (bin, args, opts) => {
      const tool = path.basename(bin);
      world.calls.push({ tool, args, signal: opts.signal });
      const custom = world.override[tool];
      if (custom !== undefined) return custom(args);
      if (tool === "initdb") {
        const d = args[args.indexOf("-D") + 1];
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "PG_VERSION"), "16\n");
        return ok();
      }
      if (tool === "pg_controldata") return ok(`pg_control version number:            1300\nDatabase system identifier:           ${world.clusterId}\n`);
      if (tool === "psql") return ok(world.oid === null ? "\n" : `${world.oid}\n`);
      if (tool === "createdb") {
        world.oid = 16384;
        return ok();
      }
      return fail(127, `unexpected ${tool}`);
    },
    psInfo: async () => null,
    stopOrphan: async (pid) => {
      orphans.push(pid);
      return "fast";
    },
    spawnPostmaster: () => {
      const h = fakeHandle(layout);
      handles.push(h);
      return h;
    },
    ...over,
  };
  const ctx: LaunchContext = {
    repoRoot: "/r",
    userData: layout.userData,
    packaged: false,
    env: {},
    bins: { uv: null },
    searchDirs: [],
    logFile: (id) => path.join(layout.userData, "logs", `${id}.log`),
    signal: new AbortController().signal,
  };
  const existing = (opts: { marker?: string | null; storageFile?: boolean; pgVersion?: string } = {}) => {
    fs.mkdirSync(layout.pgdata, { recursive: true });
    fs.writeFileSync(path.join(layout.pgdata, "PG_VERSION"), `${opts.pgVersion ?? "16"}\n`);
    fs.mkdirSync(layout.storage, { recursive: true });
    const marker = opts.marker === undefined ? serializeMarker({ clusterId: world.clusterId, databaseOid: 16384 }) : opts.marker;
    if (marker !== null) fs.writeFileSync(layout.marker, marker);
    if (opts.storageFile === true) {
      fs.mkdirSync(path.join(layout.storage, "meetings", "mtg_1"), { recursive: true });
      fs.writeFileSync(path.join(layout.storage, "meetings", "mtg_1", "original.m4a"), "audio");
    }
  };
  return { layout, world, log, handles, orphans, deps, ctx, existing, spec: embeddedPostgresSpec(deps) };
}

const tools = (w: { calls: Array<{ tool: string }> }) => w.calls.map((c) => c.tool);

async function refusal(p: Promise<unknown>): Promise<ServiceFailure> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ServiceFailure);
  expect((e as ServiceFailure).recovery).toBe("manual");
  return e as ServiceFailure;
}

describe("embeddedPostgresSpec.launch — first run", () => {
  it("creates the cluster in a temporary directory, writes the marker, then moves it into place", async () => {
    const t = setup();
    const r = await t.spec.launch(t.ctx);
    expect(tools(t.world)).toEqual(["initdb", "pg_controldata"]);
    const initdbArgs = t.world.calls[0].args;
    expect(initdbArgs[initdbArgs.indexOf("-D") + 1]).toMatch(/data\/postgres\.initdb-[0-9a-f]{8}$/);
    expect(initdbArgs).toEqual(expect.arrayContaining(["-U", "damwha", "--encoding=UTF8", "--locale=C", "--auth-local=trust", "--auth-host=reject"]));
    expect(t.world.calls[1].args[1]).toBe(initdbArgs[initdbArgs.indexOf("-D") + 1]); // 옮기기 전의 임시 디렉터리에서 id를 읽는다
    expect(fs.existsSync(path.join(t.layout.pgdata, "PG_VERSION"))).toBe(true);
    expect(parseMarker(fs.readFileSync(t.layout.marker, "utf8"))).toEqual({ clusterId: t.world.clusterId, databaseOid: null });
    expect(fs.readdirSync(t.layout.dataDir).sort()).toEqual(["postgres", "storage"]);
    expect(r).toMatchObject({ owned: true });
    expect(t.handles).toHaveLength(1);
  });

  it("removes the temporary directory and leaves no cluster and no marker when initdb fails", async () => {
    const t = setup();
    t.world.override.initdb = (args) => {
      fs.mkdirSync(args[args.indexOf("-D") + 1], { recursive: true });
      return fail(1, "initdb: could not create directory");
    };
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/데이터베이스 클러스터를 만들지 못했어요/);
    expect(fs.existsSync(t.layout.pgdata)).toBe(false);
    expect(fs.existsSync(t.layout.marker)).toBe(false);
    expect(fs.readdirSync(t.layout.dataDir)).toEqual([]);
    expect(t.handles).toHaveLength(0);
  });

  it("clears a previous run's initdb leftovers but never follows a symlink with that name", async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.layout.dataDir, "postgres.initdb-deadbeef"), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(t.layout.dataDir, "postgres.initdb-cafebabe"));
    await t.spec.launch(t.ctx);
    expect(fs.existsSync(path.join(t.layout.dataDir, "postgres.initdb-deadbeef"))).toBe(false);
    expect(fs.lstatSync(path.join(t.layout.dataDir, "postgres.initdb-cafebabe")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe("embeddedPostgresSpec.launch — refusals change nothing", () => {
  it("refuses storage with files and no cluster, without running initdb", async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.layout.storage, "meetings", "mtg_37"), { recursive: true });
    fs.writeFileSync(path.join(t.layout.storage, "meetings", "mtg_37", "original.m4a"), "audio");
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/짝이 맞지 않아/);
    expect(tools(t.world)).toEqual([]);
    expect(fs.existsSync(t.layout.pgdata)).toBe(false);
  });

  it("refuses a cluster without a marker", async () => {
    const t = setup();
    t.existing({ marker: null });
    await refusal(t.spec.launch(t.ctx));
    expect(t.handles).toHaveLength(0);
  });

  it("refuses a marker from another cluster", async () => {
    const t = setup();
    t.existing({ marker: serializeMarker({ clusterId: "999", databaseOid: 16384 }) });
    await refusal(t.spec.launch(t.ctx));
    expect(t.handles).toHaveLength(0);
  });

  it("refuses another major version without reading the control file", async () => {
    const t = setup();
    t.existing({ pgVersion: "15" });
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/PostgreSQL 버전\(15\)/);
    expect(tools(t.world)).toEqual([]);
  });

  it("refuses when the bundle is incomplete and names what is missing", async () => {
    const t = setup();
    fs.rmSync(t.deps.binaries.pgDump);
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/pg_dump/);
    expect(fs.existsSync(t.layout.dataDir)).toBe(false);
  });

  it("turns an unexpected throw into a manual failure", async () => {
    const t = setup({ runTool: async () => { throw new Error("EACCES"); } });
    await refusal(t.spec.launch(t.ctx));
  });
});

describe("embeddedPostgresSpec.launch — the lock left by a previous run", () => {
  const pidfile = (t: ReturnType<typeof setup>, pid: number) =>
    fs.writeFileSync(path.join(t.layout.pgdata, "postmaster.pid"), [String(pid), t.layout.pgdata, "0", "5432", t.layout.runDir, "", "", "ready   ", ""].join("\n"));

  // 어댑터는 deps.psInfo를 부를 때마다 속성으로 읽는다. args에 레이아웃 경로가 들어가야 해서 setup 뒤에 바꿔 끼운다.
  const ourPostgres = (t: ReturnType<typeof setup>) => async () => ({
    comm: "/Applications/Damwha.app/Contents/Resources/postgres/bin/postgres",
    args: `/Applications/Damwha.app/Contents/Resources/postgres/bin/postgres -D ${t.layout.pgdata} -c port=5432`,
  });

  it("stops an orphaned postmaster on our data directory, then starts a new one", async () => {
    const t = setup();
    t.existing();
    pidfile(t, 4242);
    t.deps.psInfo = ourPostgres(t);
    await t.spec.launch(t.ctx);
    expect(t.orphans).toEqual([4242]);
    expect(t.handles).toHaveLength(1);
    expect(t.log.join("\n")).toMatch(/4242/);
  });

  it("refuses when the orphan will not stop", async () => {
    const t = setup({ stopOrphan: async () => "leaked" });
    t.existing();
    pidfile(t, 4242);
    t.deps.psInfo = ourPostgres(t);
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/pid 4242/);
    expect(t.handles).toHaveLength(0);
  });

  it("removes a stale lock whose pid now belongs to another program", async () => {
    const t = setup({ psInfo: async () => ({ comm: "/usr/bin/vim", args: "vim notes.txt" }) });
    t.existing();
    pidfile(t, 4242);
    fs.mkdirSync(t.layout.runDir, { recursive: true });
    fs.writeFileSync(`${t.layout.socketFile}.lock`, "4242\n");
    await t.spec.launch(t.ctx);
    expect(fs.existsSync(path.join(t.layout.pgdata, "postmaster.pid"))).toBe(false);
    expect(fs.existsSync(`${t.layout.socketFile}.lock`)).toBe(false);
    expect(t.orphans).toEqual([]);
    expect(t.handles).toHaveLength(1);
  });

  it("refuses and deletes nothing when ps cannot say who holds the lock", async () => {
    const t = setup({ psInfo: async () => { throw new Error("ps timed out"); } });
    t.existing();
    pidfile(t, 4242);
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/잠금 파일의 주인\(pid 4242\)/);
    expect(fs.existsSync(path.join(t.layout.pgdata, "postmaster.pid"))).toBe(true);
    expect(t.handles).toHaveLength(0);
  });

  it("leaves a lock of a dead pid to PostgreSQL", async () => {
    const t = setup({ psInfo: async () => null });
    t.existing();
    pidfile(t, 4242);
    await t.spec.launch(t.ctx);
    expect(fs.existsSync(path.join(t.layout.pgdata, "postmaster.pid"))).toBe(true);
    expect(t.handles).toHaveLength(1);
  });
});

describe("embeddedPostgresSpec.readiness", () => {
  async function launched(t: ReturnType<typeof setup>): Promise<LaunchResult> {
    return t.spec.launch(t.ctx);
  }

  it("is not ready until our own postmaster writes ready and the socket exists", async () => {
    const t = setup();
    const r = await launched(t);
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
    t.handles[0].markReady("starting");
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
    // 이전 postmaster의 파일에 남은 ready는 우리 것이 아니다.
    fs.writeFileSync(path.join(t.layout.pgdata, "postmaster.pid"), ["9999", t.layout.pgdata, "0", "5432", t.layout.runDir, "", "", "ready   ", ""].join("\n"));
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
  });

  it("creates the database once on a fresh cluster, records its oid, and does not ask again", async () => {
    const t = setup();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.calls.length = 0;
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "ready" });
    expect(tools(t.world)).toEqual(["psql", "createdb", "psql"]);
    expect(t.world.calls[0].args).toEqual(expect.arrayContaining(["-X", "-h", t.layout.runDir, "-d", "postgres"]));
    expect(parseMarker(fs.readFileSync(t.layout.marker, "utf8"))).toEqual({ clusterId: t.world.clusterId, databaseOid: 16384 });
    t.world.calls.length = 0;
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "ready" });
    expect(tools(t.world)).toEqual([]);
  });

  it("refuses a dropped database and does not recreate it", async () => {
    const t = setup();
    t.existing({ storageFile: true });
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.oid = null;
    const out = await t.spec.readiness(r, t.ctx);
    expect(out).toMatchObject({ kind: "failed", recovery: "manual" });
    expect(tools(t.world)).not.toContain("createdb");
  });

  it("refuses a recreated database", async () => {
    const t = setup();
    t.existing();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.oid = 20000;
    expect(await t.spec.readiness(r, t.ctx)).toMatchObject({ kind: "failed", recovery: "manual" });
  });

  it("waits when psql cannot connect yet (exit 2)", async () => {
    const t = setup();
    t.existing();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.override.psql = () => fail(2, "psql: error: connection to server failed");
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
  });

  it("reports stopping as degraded", async () => {
    const t = setup();
    t.existing();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.oid = 16384;
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "ready" });
    t.handles[0].markReady("stopping");
    expect(await t.spec.readiness(r, t.ctx)).toMatchObject({ kind: "degraded" });
  });

  it("hands the launch signal to every tool so ⌘Q can end them", async () => {
    const t = setup();
    const r = await launched(t);
    t.handles[0].markReady();
    await t.spec.readiness(r, t.ctx);
    expect(t.world.calls.every((c) => c.signal === t.ctx.signal)).toBe(true);
  });
});

describe("embeddedPostgresSpec.stop", () => {
  it("uses its own fast grace, not the supervisor's, and reports a leak without escalating", async () => {
    const t = setup();
    const r = await t.spec.launch(t.ctx);
    expect(await t.spec.stop(r, { graceMs: 5 })).toEqual({ stopped: false, leaked: [5151], detail: expect.stringMatching(/pid 5151/) });
    expect(t.handles[0].stops).toEqual([PG_FAST_GRACE_MS]);
    t.handles[0].die();
    expect(await t.spec.stop(r, { graceMs: 5 })).toEqual({ stopped: true, leaked: [] });
  });

  it("restarts with backoff now that the app owns the process", () => {
    const t = setup();
    expect(t.spec.restart).toEqual({ maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] });
    expect(t.spec.gate).toBe(true);
    expect(t.spec.dependsOn).toEqual([]);
  });
});

describe("externalPostgresSpec", () => {
  it("adopts the debug database and never launches or stops anything", async () => {
    const s = externalPostgresSpec();
    const ctx = {} as LaunchContext;
    expect(await s.detectExternal(ctx)).toEqual({ kind: "adopt", detail: expect.stringMatching(/외부 DB\(디버깅\)/) });
    expect(await s.stop({ handle: null, owned: false }, { graceMs: 1 })).toEqual({ stopped: true, leaked: [] });
    expect(s.restart).toBe("never");
  });
});
