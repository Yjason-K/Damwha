import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClone } from "../../../src/process/clone";
import { runTool } from "../../../src/process/tool-runner";
import { readGeneration, writeGenerationAtomic } from "../../../src/services/postgres/generation";
import { pgLayout, type PgLayout } from "../../../src/services/postgres/layout";
import { parseMarker, serializeMarker } from "../../../src/services/postgres/pairing";
import {
  advanceJournal,
  chooseRestoreId,
  parseJournal,
  readJournal,
  replacedDirOf,
  RestoreIncomplete,
  stagingDirOf,
  writeJournalAtomic,
  type AdvanceDeps,
  type JournalStep,
  type RestoreJournal,
} from "../../../src/services/postgres/restore-journal";
import type { SnapshotInfo } from "../../../src/services/postgres/snapshot";

let root: string;
let layout: PgLayout;
let snap: SnapshotInfo;
const RID = "20260925T010203Z";
const signal = new AbortController().signal;

function makeData(dir: string, tag: string, clusterId = "111"): void {
  fs.mkdirSync(path.join(dir, "postgres"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "postgres", "PG_VERSION"), "16\n");
  fs.writeFileSync(path.join(dir, "postgres", "TAG"), tag);
  fs.mkdirSync(path.join(dir, "storage"), { recursive: true });
  fs.writeFileSync(path.join(dir, "storage", ".damwha-cluster"), serializeMarker({ clusterId, databaseOid: 16384 }));
}
const tagOf = (dir: string) => fs.readFileSync(path.join(dir, "postgres", "TAG"), "utf8");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-journal-"));
  layout = pgLayout(path.join(root, "ud"));
  makeData(layout.dataDir, "current");
  const sdir = path.join(layout.snapshots, "20260924T084933Z");
  makeData(path.join(sdir, "data"), "snapshot");
  snap = {
    id: "20260924T084933Z",
    dir: sdir,
    manifest: { id: "20260924T084933Z", createdAt: "x", fromBuild: null, toBuild: "0.4.0+0123456789ab", fromRecord: null, pgVersion: "16", clusterId: "111", databaseOid: 16384, clusterState: "shut down", complete: true },
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<AdvanceDeps> = {}): AdvanceDeps & { paused: JournalStep[] } {
  const paused: JournalStep[] = [];
  return {
    layout,
    clone: makeClone(runTool),
    findSnapshot: (id) => (id === snap.id ? snap : null),
    verifyIdentity: async (dir, m) => {
      const marker = parseMarker(fs.readFileSync(path.join(dir, "storage", ".damwha-cluster"), "utf8"));
      return marker !== null && marker.clusterId === m.clusterId && marker.databaseOid === m.databaseOid;
    },
    now: () => new Date("2026-09-25T01:05:00.000Z"),
    log: () => undefined,
    pauseAfterStep: async (s) => void paused.push(s),
    paused,
    ...over,
  };
}
const journal = (step: JournalStep): RestoreJournal => ({ id: RID, snapshot: snap.id, step, requestedAt: "2026-09-25T01:02:03.000Z", completedAt: null });
const R = () => replacedDirOf(layout, RID);
const S = () => stagingDirOf(layout, RID);

describe("advanceJournal — happy path", () => {
  it("requested → hold swaps data/ for a clone of the snapshot and keeps the old data aside", async () => {
    writeJournalAtomic(layout.restoreJournal, journal("requested"));
    const d = deps();
    const out = await advanceJournal(d, journal("requested"), signal);
    expect(out.kind).toBe("hold");
    expect(tagOf(layout.dataDir)).toBe("snapshot");
    expect(tagOf(R())).toBe("current");
    expect(fs.existsSync(S())).toBe(false);
    expect(tagOf(path.join(snap.dir, "data"))).toBe("snapshot");
    expect(d.paused).toEqual(["staged", "moved-aside", "hold"]);
    const saved = readJournal(layout.restoreJournal);
    expect(saved.kind === "ok" && saved.journal.step).toBe("hold");
    expect(saved.kind === "ok" && saved.journal.completedAt).toBe("2026-09-25T01:05:00.000Z");
  });
  it("marks the restored data's generation record with restoredFrom, keeping build and snapshot", async () => {
    writeGenerationAtomic(path.join(snap.dir, "data", ".damwha-generation"), { build: "0.3.9+aaaaaaaaaaaa", snapshot: "OLD" });
    await advanceJournal(deps(), journal("requested"), signal);
    expect(readGeneration(layout.generationFile)).toEqual({ build: "0.3.9+aaaaaaaaaaaa", snapshot: "OLD", restoredFrom: RID });
  });
  it("writes restoredFrom with null build/snapshot when the snapshot had no record", async () => {
    await advanceJournal(deps(), journal("requested"), signal);
    expect(readGeneration(layout.generationFile)).toEqual({ build: null, snapshot: null, restoredFrom: RID });
  });
});

describe("advanceJournal — resume after a crash at every point", () => {
  it("staged with data/ already moved aside (crash after rename, before step write)", async () => {
    await advanceJournal(deps(), journal("requested"), signal).catch(() => undefined);
    // 다시 처음부터 만든다: requested까지 해 두고 D→R만 손으로 한 상태
    fs.rmSync(layout.dataDir, { recursive: true, force: true });
    fs.rmSync(R(), { recursive: true, force: true });
    makeData(layout.dataDir, "current");
    await makeClone(runTool)(path.join(snap.dir, "data"), S());
    fs.renameSync(layout.dataDir, R());
    const out = await advanceJournal(deps(), journal("staged"), signal);
    expect(out.kind).toBe("hold");
    expect(tagOf(layout.dataDir)).toBe("snapshot");
    expect(tagOf(R())).toBe("current");
  });
  it("moved-aside with staging already renamed into data/ (crash after rename, before step write)", async () => {
    fs.renameSync(layout.dataDir, R());
    await makeClone(runTool)(path.join(snap.dir, "data"), layout.dataDir);
    const out = await advanceJournal(deps(), journal("moved-aside"), signal);
    expect(out.kind).toBe("hold");
    expect(readGeneration(layout.generationFile)?.restoredFrom).toBe(RID);
  });
  it("requested with a stale staging dir from an interrupted clone re-clones it", async () => {
    fs.mkdirSync(S(), { recursive: true });
    fs.writeFileSync(path.join(S(), "junk"), "half");
    const out = await advanceJournal(deps(), journal("requested"), signal);
    expect(out.kind).toBe("hold");
    expect(fs.existsSync(path.join(layout.dataDir, "junk"))).toBe(false);
  });
  it("hold is idempotent and moves nothing", async () => {
    await advanceJournal(deps(), journal("requested"), signal);
    const before = tagOf(layout.dataDir);
    const out = await advanceJournal(deps(), { ...journal("hold"), completedAt: "t" }, signal);
    expect(out.kind).toBe("hold");
    expect(tagOf(layout.dataDir)).toBe(before);
  });
});

describe("advanceJournal — refusals move nothing", () => {
  it.each<[string, JournalStep, () => void]>([
    ["requested with R present", "requested", () => makeData(R(), "stray")],
    ["staged without staging", "staged", () => undefined],
    ["staged with both D and R", "staged", () => { makeData(R(), "stray"); makeData(S(), "snapshot"); }],
    ["moved-aside with neither D nor S", "moved-aside", () => { fs.renameSync(layout.dataDir, R()); }],
    ["moved-aside with D, R and S all present", "moved-aside", () => { makeData(R(), "stray"); makeData(S(), "snapshot"); }],
  ])("%s", async (_n, step, arrange) => {
    arrange();
    const snapshotOf = (p: string) => (fs.existsSync(p) ? tagOf(p) : null);
    const before = [snapshotOf(layout.dataDir), snapshotOf(R()), snapshotOf(S())];
    await expect(advanceJournal(deps(), journal(step), signal)).rejects.toBeInstanceOf(RestoreIncomplete);
    expect([snapshotOf(layout.dataDir), snapshotOf(R()), snapshotOf(S())]).toEqual(before);
  });
  it("moved-aside where data/ is not the snapshot (identity mismatch) refuses", async () => {
    fs.renameSync(layout.dataDir, R());
    makeData(layout.dataDir, "someone-else", "999");
    await expect(advanceJournal(deps(), journal("moved-aside"), signal)).rejects.toBeInstanceOf(RestoreIncomplete);
  });
});

describe("advanceJournal — requested failures abort before touching data/", () => {
  it("snapshot missing → aborted, journal removed, data/ untouched", async () => {
    writeJournalAtomic(layout.restoreJournal, journal("requested"));
    const out = await advanceJournal(deps({ findSnapshot: () => null }), journal("requested"), signal);
    expect(out.kind).toBe("aborted");
    expect(tagOf(layout.dataDir)).toBe("current");
    expect(readJournal(layout.restoreJournal).kind).toBe("none");
  });
  it("clone failure → aborted, staging removed", async () => {
    writeJournalAtomic(layout.restoreJournal, journal("requested"));
    const out = await advanceJournal(deps({ clone: async (_s, dst) => { fs.mkdirSync(dst); throw new Error("ENOSPC"); } }), journal("requested"), signal);
    expect(out).toEqual({ kind: "aborted", reason: expect.stringMatching(/ENOSPC/) });
    expect(fs.existsSync(S())).toBe(false);
    expect(tagOf(layout.dataDir)).toBe("current");
  });
  it("staging identity mismatch → aborted", async () => {
    const out = await advanceJournal(deps({ verifyIdentity: async () => false }), journal("requested"), signal);
    expect(out.kind).toBe("aborted");
    expect(tagOf(layout.dataDir)).toBe("current");
  });
});

describe("journal file and ids", () => {
  it("parses a valid journal and rejects garbage", () => {
    expect(parseJournal(JSON.stringify(journal("staged")))).toEqual(journal("staged"));
    expect(parseJournal('{"id":"x","snapshot":"y","step":"weird","requestedAt":"t","completedAt":null}')).toBeNull();
    expect(parseJournal("nope")).toBeNull();
  });
  it("readJournal distinguishes none from unreadable", () => {
    expect(readJournal(layout.restoreJournal).kind).toBe("none");
    fs.writeFileSync(layout.restoreJournal, "{");
    expect(readJournal(layout.restoreJournal).kind).toBe("unreadable");
  });
  it("chooseRestoreId skips ids whose replaced or staging dir exists", () => {
    const now = new Date("2026-09-25T01:02:03.000Z");
    makeData(replacedDirOf(layout, RID), "x");
    fs.mkdirSync(stagingDirOf(layout, `${RID}-2`), { recursive: true });
    expect(chooseRestoreId(layout, now)).toBe(`${RID}-3`);
  });
});
