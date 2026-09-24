import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseHold, runDataGuard, type DataGuardDeps } from "../../src/app/data-guard";
import { makeClone } from "../../src/process/clone";
import { runTool } from "../../src/process/tool-runner";
import { ServiceFailure } from "../../src/services/failure";
import { readGeneration, writeGenerationAtomic } from "../../src/services/postgres/generation";
import { pgLayout, type PgLayout } from "../../src/services/postgres/layout";
import { serializeMarker } from "../../src/services/postgres/pairing";
import { replacedDirOf, writeJournalAtomic } from "../../src/services/postgres/restore-journal";
import { listCompleteSnapshots, takeSnapshot } from "../../src/services/postgres/snapshot";

let root: string;
let layout: PgLayout;
const BUILD = "0.4.0+0123456789ab";
const CONTROL = "Database system identifier:           111\nDatabase cluster state:               shut down\n";
const signal = new AbortController().signal;

function makeCluster(): void {
  fs.mkdirSync(layout.pgdata, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.pgdata, "PG_VERSION"), "16\n");
  fs.mkdirSync(layout.storage, { recursive: true });
  fs.writeFileSync(layout.marker, serializeMarker({ clusterId: "111", databaseOid: 16384 }));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-guard-"));
  layout = pgLayout(path.join(root, "ud"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<DataGuardDeps> = {}): DataGuardDeps & { events: string[] } {
  const events: string[] = [];
  return {
    packaged: true,
    external: false,
    journal: "advance",
    currentBuild: BUILD,
    buildInfoFile: "/R/build-info.json",
    layout,
    readControldata: async () => CONTROL,
    lock: { layout, psInfo: async () => null, stopOrphan: async () => "fast", log: () => undefined },
    clone: makeClone(runTool),
    now: () => new Date("2026-09-24T08:49:33.000Z"),
    log: (l) => void events.push(l),
    events,
    ...over,
  } as DataGuardDeps & { events: string[] };
}

describe("runDataGuard — snapshots", () => {
  it("packaged, no record: takes a snapshot, then records the generation", async () => {
    makeCluster();
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("proceed");
    expect(out.kind === "proceed" && out.snapshot?.manifest.toBuild).toBe(BUILD);
    expect(readGeneration(layout.generationFile)).toEqual({ build: BUILD, snapshot: "20260924T084933Z" });
  });
  it("same build recorded: no snapshot", async () => {
    makeCluster();
    writeGenerationAtomic(layout.generationFile, { build: BUILD, snapshot: "X" });
    const out = await runDataGuard(deps(), signal);
    expect(out.kind === "proceed" && out.snapshot).toBeNull();
    expect(fs.existsSync(layout.snapshots)).toBe(false);
  });
  it("dev: no snapshot and no record written", async () => {
    makeCluster();
    await runDataGuard(deps({ packaged: false, currentBuild: null }), signal);
    expect(fs.existsSync(layout.snapshots)).toBe(false);
    expect(fs.existsSync(layout.generationFile)).toBe(false);
  });
  it("external DB mode: does nothing at all", async () => {
    makeCluster();
    writeJournalAtomic(layout.restoreJournal, { id: "20260925T010203Z", snapshot: "S", step: "requested", requestedAt: "t", completedAt: null });
    const out = await runDataGuard(deps({ external: true }), signal);
    expect(out).toEqual({ kind: "proceed", snapshot: null, notice: null });
    expect(fs.existsSync(layout.restoreJournal)).toBe(true);
  });
  it("first install (no pgdata): no snapshot", async () => {
    const out = await runDataGuard(deps(), signal);
    expect(out.kind === "proceed" && out.snapshot).toBeNull();
  });
  it("pairing refusal (marker missing): creates nothing and does not touch the lock", async () => {
    makeCluster();
    fs.rmSync(layout.marker);
    let lockTouched = false;
    const out = await runDataGuard(deps({ lock: { layout, psInfo: async () => { lockTouched = true; return null; }, stopOrphan: async () => "fast", log: () => undefined } }), signal);
    expect(out.kind === "proceed" && out.snapshot).toBeNull();
    expect(fs.existsSync(layout.snapshots)).toBe(false);
    expect(lockTouched).toBe(false);
  });
  it("snapshot failure: manual snapshotFailed, no record, no .partial left", async () => {
    makeCluster();
    const err = await runDataGuard(deps({ clone: async () => { throw new Error("ENOSPC"); } }), signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceFailure);
    expect((err as ServiceFailure).recovery).toBe("manual");
    expect((err as Error).message).toMatch(/업데이트 전 스냅샷을 만들지 못해 시작하지 않았어요/);
    expect(fs.existsSync(layout.generationFile)).toBe(false);
    expect(fs.readdirSync(layout.snapshots)).toEqual([]);
  });
  it("prune protects the snapshot just taken even when clock skew sorts its id oldest", async () => {
    makeCluster();
    const mk = (at: string, b: string) =>
      takeSnapshot({ layout, clone: makeClone(runTool), readControldata: async () => CONTROL, now: () => new Date(at), log: () => undefined },
        { fromBuild: null, toBuild: b, fromRecord: b }, signal);
    await mk("2026-09-25T00:00:00.000Z", "b1");
    await mk("2026-09-26T00:00:00.000Z", "b2");
    await mk("2026-09-27T00:00:00.000Z", "b3");
    // 시계가 뒤로 가 있다 — 새 스냅샷의 id가 셋 중 가장 오래된 것으로 정렬된다
    const out = await runDataGuard(deps({ now: () => new Date("2026-09-20T00:00:00.000Z") }), signal);
    const sid = out.kind === "proceed" ? out.snapshot!.id : "";
    expect(sid).toBe("20260920T000000Z");
    expect(listCompleteSnapshots(layout.snapshots).map((s) => s.id)).toContain(sid);
    const rec = readGeneration(layout.generationFile);
    expect(rec?.snapshot).toBe(sid);
    expect(fs.existsSync(path.join(layout.snapshots, rec!.snapshot!))).toBe(true);
  });
  it("crash between snapshot rename and record write: reuses that snapshot instead of taking another", async () => {
    makeCluster();
    await takeSnapshot({ layout, clone: makeClone(runTool), readControldata: async () => CONTROL, now: () => new Date("2026-09-24T08:49:33.000Z"), log: () => undefined },
      { fromBuild: null, toBuild: BUILD, fromRecord: null }, signal);
    for (let i = 0; i < 3; i += 1) {
      fs.rmSync(layout.generationFile, { force: true });
      await runDataGuard(deps({ now: () => new Date(`2026-09-24T09:0${i}:00.000Z`) }), signal);
    }
    expect(listCompleteSnapshots(layout.snapshots).map((s) => s.id)).toEqual(["20260924T084933Z"]);
  });
  it("packaged without build info: manual buildInfoMissing", async () => {
    makeCluster();
    await expect(runDataGuard(deps({ currentBuild: null }), signal)).rejects.toMatchObject({ recovery: "manual", message: expect.stringMatching(/빌드 정보/) });
  });
  it("lock refusal propagates as manual", async () => {
    makeCluster();
    fs.writeFileSync(path.join(layout.pgdata, "postmaster.pid"), ["4242", layout.pgdata, "0", "5432", layout.runDir, "", "", "ready   ", ""].join("\n"));
    const lock = { layout, psInfo: async () => { throw new Error("ps timed out"); }, stopOrphan: async () => "fast" as const, log: () => undefined };
    await expect(runDataGuard(deps({ lock }), signal)).rejects.toMatchObject({ recovery: "manual" });
  });
});

describe("runDataGuard — journal", () => {
  async function snapshotThenRequest(): Promise<string> {
    makeCluster();
    const out = await runDataGuard(deps(), signal);
    const sid = out.kind === "proceed" ? out.snapshot!.id : "";
    writeJournalAtomic(layout.restoreJournal, { id: "20260925T010203Z", snapshot: sid, step: "requested", requestedAt: "t", completedAt: null });
    return sid;
  }
  it("requested → hold, before decideCluster", async () => {
    await snapshotThenRequest();
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("hold");
    expect(fs.existsSync(replacedDirOf(layout, "20260925T010203Z"))).toBe(true);
  });
  it("journal is processed before decideCluster when data/ is missing (never initdb-shaped)", async () => {
    await snapshotThenRequest();
    // staged까지 진행된 뒤 D→R rename 직후 끊긴 상태를 만든다
    await runDataGuard(deps({ pauseAfterStep: async (s) => { if (s === "staged") throw new Error("crash"); } }), signal).catch(() => undefined);
    fs.renameSync(layout.dataDir, replacedDirOf(layout, "20260925T010203Z"));
    expect(fs.existsSync(layout.dataDir)).toBe(false);
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("hold");
    expect(fs.existsSync(path.join(layout.pgdata, "PG_VERSION"))).toBe(true);
  });
  it("unreadable journal: manual refusal, nothing moved", async () => {
    makeCluster();
    fs.writeFileSync(layout.restoreJournal, "{");
    await expect(runDataGuard(deps(), signal)).rejects.toMatchObject({ recovery: "manual", message: expect.stringMatching(/되돌리기 기록을 읽을 수 없어요/) });
    expect(fs.existsSync(layout.pgdata)).toBe(true);
  });
  it("aborted restore: proceeds normally with a restoreAborted notice", async () => {
    makeCluster();
    writeJournalAtomic(layout.restoreJournal, { id: "20260925T010203Z", snapshot: "20990101T000000Z", step: "requested", requestedAt: "t", completedAt: null });
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("proceed");
    expect(out.kind === "proceed" && out.notice).toMatch(/되돌리기를 취소했어요/);
  });
  it("hold then release: next guard takes a NEW snapshot (fromRecord differs), not the old one", async () => {
    const sid = await snapshotThenRequest();
    await runDataGuard(deps(), signal);
    releaseHold(layout);
    const out = await runDataGuard(deps({ now: () => new Date("2026-10-01T00:00:00.000Z") }), signal);
    expect(out.kind === "proceed" && out.snapshot?.id).not.toBe(sid);
    expect(out.kind === "proceed" && out.snapshot?.manifest.fromRecord).toMatch(/restoredFrom/);
  });
  it("staging whose pg_controldata id differs from the manifest is refused (aborted, data/ untouched)", async () => {
    await snapshotThenRequest();
    const other = "Database system identifier:           999\nDatabase cluster state:               shut down\n";
    const out = await runDataGuard(deps({ readControldata: async (p) => (p.includes("restore-staging") ? other : CONTROL) }), signal);
    expect(out.kind).toBe("proceed");
    expect(out.kind === "proceed" && out.notice).toMatch(/되돌리기를 취소했어요/);
    expect(fs.existsSync(replacedDirOf(layout, "20260925T010203Z"))).toBe(false);
  });
  it("data/ already swapped in but with a different pg_controldata id → restoreIncomplete", async () => {
    await snapshotThenRequest();
    await runDataGuard(deps({ pauseAfterStep: async (s) => { if (s === "moved-aside") throw new Error("crash"); } }), signal).catch(() => undefined);
    // moved-aside 기록 직후(D→R 뒤, S→D 전) 끊겼다. 다음 기동이 S→D를 한 뒤 data/의 신원을 보는데, 그 pg_controldata id가
    // manifest와 다르다 — 마커만 보는 검사라면 통과해 버리는 경우다.
    const other = "Database system identifier:           999\nDatabase cluster state:               shut down\n";
    await expect(runDataGuard(deps({ readControldata: async (p) => (p === layout.pgdata ? other : CONTROL) }), signal)).rejects.toMatchObject({
      recovery: "manual",
      message: expect.stringMatching(/되돌리는 작업을 마치지 못했어요/),
    });
  });
  it("a journal pointing at a snapshot of another PG major is not restored", async () => {
    await snapshotThenRequest();
    const snapDir = listCompleteSnapshots(layout.snapshots)[0].dir;
    const m = JSON.parse(fs.readFileSync(path.join(snapDir, "manifest.json"), "utf8"));
    fs.writeFileSync(path.join(snapDir, "manifest.json"), JSON.stringify({ ...m, pgVersion: "15" }));
    const out = await runDataGuard(deps(), signal);
    expect(out.kind === "proceed" && out.notice).toMatch(/되돌리기를 취소했어요/);
    expect(fs.existsSync(replacedDirOf(layout, "20260925T010203Z"))).toBe(false);
  });
  it("an unexpected throw after staged becomes restoreIncomplete and the journal stays at staged", async () => {
    await snapshotThenRequest();
    await expect(
      runDataGuard(deps({ pauseAfterStep: async (s) => { if (s === "staged") throw new Error("crash"); } }), signal),
    ).rejects.toMatchObject({ recovery: "manual", message: expect.stringMatching(/되돌리는 작업을 마치지 못했어요/) });
    expect(fs.existsSync(layout.restoreJournal)).toBe(true);
    expect(JSON.parse(fs.readFileSync(layout.restoreJournal, "utf8")).step).toBe("staged");
  });
  it("prune never deletes the snapshot a journal points at", async () => {
    const sid = await snapshotThenRequest();
    // 저널이 있는 동안 두 번 더 판올림이 일어난 것처럼 스냅샷을 쌓는다
    await takeSnapshot({ layout, clone: makeClone(runTool), readControldata: async () => CONTROL, now: () => new Date("2026-09-26T00:00:00.000Z"), log: () => undefined }, { fromBuild: null, toBuild: "b2", fromRecord: "x" }, signal);
    await takeSnapshot({ layout, clone: makeClone(runTool), readControldata: async () => CONTROL, now: () => new Date("2026-09-27T00:00:00.000Z"), log: () => undefined }, { fromBuild: null, toBuild: "b3", fromRecord: "y" }, signal);
    await runDataGuard(deps(), signal);
    expect(listCompleteSnapshots(layout.snapshots).map((s) => s.id)).toContain(sid);
  });
});

describe("runDataGuard — journal: \"refuse\" (preLaunch hook)", () => {
  function lockSpy(): { lock: DataGuardDeps["lock"]; calls: () => number } {
    let n = 0;
    return { lock: { layout, psInfo: async () => { n += 1; return null; }, stopOrphan: async () => "fast", log: () => undefined }, calls: () => n };
  }
  function entries(): string[] {
    return fs.readdirSync(layout.userData).sort();
  }
  it("requested journal: refuses manual with restorePending and touches nothing", async () => {
    makeCluster();
    const out = await runDataGuard(deps(), signal);
    const sid = out.kind === "proceed" ? out.snapshot!.id : "";
    writeJournalAtomic(layout.restoreJournal, { id: "20260925T010203Z", snapshot: sid, step: "requested", requestedAt: "t", completedAt: null });
    // 락 확인이 불리면 알 수 있게 postmaster.pid를 둔다
    fs.writeFileSync(path.join(layout.pgdata, "postmaster.pid"), ["4242", layout.pgdata, "0", "5432", layout.runDir, "", "", "ready   ", ""].join("\n"));
    const before = fs.readFileSync(layout.restoreJournal);
    const beforeEntries = entries();
    const spy = lockSpy();
    await expect(runDataGuard(deps({ journal: "refuse", lock: spy.lock }), signal)).rejects.toMatchObject({
      recovery: "manual",
      message: expect.stringMatching(/되돌리는 작업이 기다리고 있어요/),
    });
    expect(fs.existsSync(path.join(layout.pgdata, "PG_VERSION"))).toBe(true);
    expect(fs.existsSync(path.join(layout.pgdata, "postmaster.pid"))).toBe(true);
    expect(fs.existsSync(replacedDirOf(layout, "20260925T010203Z"))).toBe(false);
    expect(fs.existsSync(layout.restoreStaging)).toBe(false);
    expect(entries()).toEqual(beforeEntries);
    expect(fs.readFileSync(layout.restoreJournal).equals(before)).toBe(true);
    expect(spy.calls()).toBe(0);
  });
  it("unreadable journal: the same refusal, journal untouched", async () => {
    makeCluster();
    fs.writeFileSync(layout.restoreJournal, "{");
    const spy = lockSpy();
    await expect(runDataGuard(deps({ journal: "refuse", lock: spy.lock }), signal)).rejects.toMatchObject({
      recovery: "manual",
      message: expect.stringMatching(/되돌리는 작업이 기다리고 있어요/),
    });
    expect(fs.readFileSync(layout.restoreJournal, "utf8")).toBe("{");
    expect(fs.existsSync(layout.restoreStaging)).toBe(false);
    expect(spy.calls()).toBe(0);
  });
  it("no journal: refuse mode runs the guard normally", async () => {
    makeCluster();
    const out = await runDataGuard(deps({ journal: "refuse" }), signal);
    expect(out.kind === "proceed" && out.snapshot?.manifest.toBuild).toBe(BUILD);
  });
});
