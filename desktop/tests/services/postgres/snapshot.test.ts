import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClone, type CloneFn } from "../../../src/process/clone";
import { runTool } from "../../../src/process/tool-runner";
import { parseGeneration, readGenerationText } from "../../../src/services/postgres/generation";
import { pgLayout, type PgLayout } from "../../../src/services/postgres/layout";
import { serializeMarker } from "../../../src/services/postgres/pairing";
import {
  findUnrecorded,
  KEEP_SNAPSHOTS,
  listCompleteSnapshots,
  parseManifest,
  pruneSnapshots,
  removeIncompleteSnapshots,
  restorableSnapshots,
  takeSnapshot,
  type SnapshotManifest,
  type TakeSnapshotDeps,
} from "../../../src/services/postgres/snapshot";

let root: string;
let layout: PgLayout;
const CONTROL = "Database system identifier:           7687238228739395787\nDatabase cluster state:               shut down\n";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-snap-"));
  layout = pgLayout(path.join(root, "ud"));
  fs.mkdirSync(layout.pgdata, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.pgdata, "PG_VERSION"), "16\n");
  fs.mkdirSync(layout.storage, { recursive: true });
  fs.writeFileSync(layout.marker, serializeMarker({ clusterId: "7687238228739395787", databaseOid: 16384 }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<TakeSnapshotDeps> = {}, at = "2026-09-24T08:49:33.000Z"): TakeSnapshotDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    layout,
    clone: makeClone(runTool),
    readControldata: async () => CONTROL,
    now: () => new Date(at),
    log: (l) => void lines.push(l),
    lines,
    ...over,
  };
}
const INPUT = { fromBuild: null, toBuild: "0.4.0+0123456789ab", fromRecord: null };
const signal = new AbortController().signal;

function fakeSnapshot(id: string, m: Partial<SnapshotManifest> = {}, withData = true): void {
  const dir = path.join(layout.snapshots, id);
  fs.mkdirSync(path.join(dir, "data", "postgres"), { recursive: true });
  if (withData) {
    fs.writeFileSync(path.join(dir, "data", "postgres", "PG_VERSION"), "16\n");
    fs.mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "storage", ".damwha-cluster"), serializeMarker({ clusterId: "7687238228739395787", databaseOid: 16384 }));
  }
  const manifest: SnapshotManifest = {
    id, createdAt: "2026-09-24T00:00:00.000Z", fromBuild: null, toBuild: "0.4.0+0123456789ab", fromRecord: null,
    pgVersion: "16", clusterId: "7687238228739395787", databaseOid: 16384, clusterState: "shut down", complete: true, ...m,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

describe("takeSnapshot", () => {
  it("clones data/ under <id>/data, writes a complete manifest read from the copy, and leaves no .partial", async () => {
    const info = await takeSnapshot(deps(), INPUT, signal);
    expect(info.id).toBe("20260924T084933Z");
    expect(fs.readFileSync(path.join(info.dir, "data", "postgres", "PG_VERSION"), "utf8")).toBe("16\n");
    expect(info.manifest).toMatchObject({ toBuild: "0.4.0+0123456789ab", fromBuild: null, fromRecord: null, clusterId: "7687238228739395787", databaseOid: 16384, clusterState: "shut down", pgVersion: "16", complete: true });
    expect(fs.readdirSync(layout.snapshots)).toEqual(["20260924T084933Z"]);
  });
  it("reads pg_controldata from the copy, not the live cluster", async () => {
    const seen: string[] = [];
    await takeSnapshot(deps({ readControldata: async (p) => (seen.push(p), CONTROL) }), INPUT, signal);
    expect(seen).toEqual([path.join(layout.snapshots, "20260924T084933Z.partial", "data", "postgres")]);
  });
  it("records a null databaseOid from the copy's marker", async () => {
    fs.writeFileSync(layout.marker, serializeMarker({ clusterId: "7687238228739395787", databaseOid: null }));
    expect((await takeSnapshot(deps(), INPUT, signal)).manifest.databaseOid).toBeNull();
  });
  it("suffixes a second snapshot in the same second", async () => {
    await takeSnapshot(deps(), INPUT, signal);
    expect((await takeSnapshot(deps(), INPUT, signal)).id).toBe("20260924T084933Z-2");
  });
  it("removes its .partial when the clone fails and rethrows", async () => {
    const boom: CloneFn = async () => { throw new Error("ENOSPC"); };
    await expect(takeSnapshot(deps({ clone: boom }), INPUT, signal)).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(layout.snapshots)).toEqual([]);
  });
  it("removes its .partial when controldata has no identifier", async () => {
    await expect(takeSnapshot(deps({ readControldata: async () => "garbage" }), INPUT, signal)).rejects.toThrow();
    expect(fs.readdirSync(layout.snapshots)).toEqual([]);
  });
});

describe("listing, reuse and retention", () => {
  it("lists only complete snapshots, newest first", () => {
    fakeSnapshot("20260920T000000Z");
    fakeSnapshot("20260922T000000Z");
    fs.mkdirSync(path.join(layout.snapshots, "20260923T000000Z.partial"));
    fs.mkdirSync(path.join(layout.snapshots, "20260921T000000Z"));
    expect(listCompleteSnapshots(layout.snapshots).map((s) => s.id)).toEqual(["20260922T000000Z", "20260920T000000Z"]);
  });
  it("restorable: same PG major and a readable marker, at most KEEP_SNAPSHOTS", () => {
    fakeSnapshot("20260920T000000Z");
    fakeSnapshot("20260921T000000Z", { pgVersion: "17" });
    fakeSnapshot("20260922T000000Z");
    fakeSnapshot("20260923T000000Z");
    fakeSnapshot("20260924T000000Z", {}, false);
    expect(restorableSnapshots(layout.snapshots, "16").map((s) => s.id)).toEqual(["20260923T000000Z", "20260922T000000Z"]);
    expect(KEEP_SNAPSHOTS).toBe(2);
  });
  it("findUnrecorded matches toBuild AND fromRecord", () => {
    fakeSnapshot("20260924T000000Z", { toBuild: "0.4.0+0123456789ab", fromRecord: null });
    expect(findUnrecorded(layout.snapshots, "0.4.0+0123456789ab", null)?.id).toBe("20260924T000000Z");
  });
  it("findUnrecorded ignores a snapshot whose fromRecord differs (restored data)", () => {
    fakeSnapshot("20260924T000000Z", { toBuild: "0.4.0+0123456789ab", fromRecord: null });
    expect(findUnrecorded(layout.snapshots, "0.4.0+0123456789ab", '{"build":null,"snapshot":null,"restoredFrom":"R"}')).toBeNull();
    expect(findUnrecorded(layout.snapshots, "0.4.1+ba9876543210", null)).toBeNull();
  });
  it("a manually restored record (docs/RESTORE.md §3) parses and never matches a fromRecord:null snapshot", () => {
    const text = '{"build":null,"snapshot":null,"restoredFrom":"manual-20260925010203"}\n';
    expect(parseGeneration(text)).toEqual({ build: null, snapshot: null, restoredFrom: "manual-20260925010203" });
    fakeSnapshot("20260924T000000Z", { toBuild: "0.4.0+0123456789ab", fromRecord: null });
    expect(findUnrecorded(layout.snapshots, "0.4.0+0123456789ab", text)).toBeNull();
  });
  it("the printf line in docs/RESTORE.md §3 writes that record", () => {
    const doc = fs.readFileSync(path.join(__dirname, "../../../../docs/RESTORE.md"), "utf8");
    const line = doc.split("\n").find((l) => l.startsWith("printf ") && l.includes(".damwha-generation"));
    expect(line).toBeDefined();
    const D = path.join(root, "D");
    fs.mkdirSync(path.join(D, "data"), { recursive: true });
    execFileSync("/bin/sh", ["-c", line!], { env: { ...process.env, D } });
    const text = readGenerationText(path.join(D, "data", ".damwha-generation"));
    expect(parseGeneration(text!)?.restoredFrom).toMatch(/^manual-\d{14}$/);
    fakeSnapshot("20260924T000000Z", { toBuild: "0.4.0+0123456789ab", fromRecord: null });
    expect(findUnrecorded(layout.snapshots, "0.4.0+0123456789ab", text)).toBeNull();
  });
  it("removeIncompleteSnapshots deletes .partial and manifest-less dirs only", () => {
    fakeSnapshot("20260920T000000Z");
    fs.mkdirSync(path.join(layout.snapshots, "20260921T000000Z.partial"));
    fs.mkdirSync(path.join(layout.snapshots, "20260922T000000Z"));
    fs.mkdirSync(path.join(layout.snapshots, "keep-me"));
    const log: string[] = [];
    removeIncompleteSnapshots(layout.snapshots, (l) => void log.push(l));
    expect(fs.readdirSync(layout.snapshots).sort()).toEqual(["20260920T000000Z", "keep-me"]);
    expect(log).toHaveLength(2);
  });
  it("prune keeps the newest KEEP_SNAPSHOTS and never a protected one", () => {
    for (const id of ["20260920T000000Z", "20260921T000000Z", "20260922T000000Z", "20260923T000000Z"]) fakeSnapshot(id);
    pruneSnapshots(layout.snapshots, new Set(["20260920T000000Z"]), () => undefined);
    expect(fs.readdirSync(layout.snapshots).sort()).toEqual(["20260920T000000Z", "20260922T000000Z", "20260923T000000Z"]);
  });
  it("prune does not follow a symlinked snapshot", () => {
    for (const id of ["20260921T000000Z", "20260922T000000Z"]) fakeSnapshot(id);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "manifest.json"), fs.readFileSync(path.join(layout.snapshots, "20260921T000000Z", "manifest.json")));
    fs.symlinkSync(outside, path.join(layout.snapshots, "20260920T000000Z"));
    pruneSnapshots(layout.snapshots, new Set(), () => undefined);
    expect(fs.existsSync(path.join(outside, "manifest.json"))).toBe(true);
  });
  it("parseManifest rejects complete:false and wrong types", () => {
    expect(parseManifest('{"complete":false}')).toBeNull();
    expect(parseManifest("nope")).toBeNull();
  });
});
