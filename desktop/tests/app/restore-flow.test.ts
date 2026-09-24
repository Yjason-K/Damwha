import { describe, expect, it } from "vitest";
import {
  afterIo,
  confirmRestoreDialog,
  createIoTracker,
  holdDialog,
  parsePauseStep,
  RELEASES_PAGE_URL,
  restoreMenuEnabled,
  snapshotLine,
  versionOfBuild,
} from "../../src/app/restore-flow";
import type { SnapshotInfo, SnapshotManifest } from "../../src/services/postgres/snapshot";

const fmt = (iso: string) => `T(${iso})`;
const manifest = (m: Partial<SnapshotManifest> = {}): SnapshotManifest => ({
  id: "20260924T084933Z", createdAt: "2026-09-24T08:49:33.000Z", fromBuild: "0.3.1+0123456789ab", toBuild: "0.4.0+ba9876543210",
  fromRecord: null, pgVersion: "16", clusterId: "1", databaseOid: 1, clusterState: "shut down", complete: true, ...m,
});
const info = (m: Partial<SnapshotManifest> = {}): SnapshotInfo => ({ id: m.id ?? "20260924T084933Z", dir: "/d", manifest: manifest(m) });

describe("menu enablement", () => {
  it("enabled only with a restorable snapshot, no journal, embedded mode", () => {
    expect(restoreMenuEnabled({ external: false, restorable: [info()], journalPresent: false })).toBe(true);
    expect(restoreMenuEnabled({ external: true, restorable: [info()], journalPresent: false })).toBe(false);
    expect(restoreMenuEnabled({ external: false, restorable: [], journalPresent: false })).toBe(false);
    expect(restoreMenuEnabled({ external: false, restorable: [info()], journalPresent: true })).toBe(false);
  });
});

describe("wording", () => {
  it("versionOfBuild strips the commit", () => {
    expect(versionOfBuild("0.4.0+ba9876543210")).toBe("0.4.0");
    expect(versionOfBuild(null)).toBeNull();
  });
  it("snapshot line names versions and time, and flags an unclean cluster", () => {
    expect(snapshotLine(manifest(), fmt)).toBe("0.3.1 → 0.4.0 업데이트 직전 · T(2026-09-24T08:49:33.000Z)");
    expect(snapshotLine(manifest({ fromBuild: null, clusterState: "in production" }), fmt)).toBe(
      "이전 판 → 0.4.0 업데이트 직전 · T(2026-09-24T08:49:33.000Z) (비정상 종료 뒤의 상태)",
    );
  });
});

describe("confirm dialog", () => {
  it("one button per snapshot plus cancel; Escape picks cancel", () => {
    const d = confirmRestoreDialog([info(), info({ id: "20260920T000000Z", createdAt: "2026-09-20T00:00:00.000Z" })], fmt);
    expect(d.options.buttons).toHaveLength(3);
    expect(d.options.cancelId).toBe(2);
    expect(d.choices).toEqual(["20260924T084933Z", "20260920T000000Z", null]);
    expect(String(d.options.detail)).toMatch(/data\.replaced-/);
    expect(String(d.options.detail)).toMatch(/토큰·마이크 권한·모델은 그대로/);
  });
});

describe("hold dialog", () => {
  const journal = { id: "20260925T010203Z", snapshot: "20260924T084933Z", step: "hold" as const, requestedAt: "r", completedAt: "2026-09-25T01:05:00.000Z" };
  it("speaks in dates, names the replaced dir, offers quit/download/continue with quit as cancel", () => {
    const d = holdDialog({ journal, snapshot: info(), replacedDir: "/U/data.replaced-20260925T010203Z" }, fmt);
    expect(String(d.options.message)).toMatch(/T\(2026-09-25T01:05:00.000Z\)에 업데이트 전 데이터/);
    expect(String(d.options.detail)).toMatch(/그 뒤 이전 판에서 쓴 내용은 지금 데이터에 그대로 있어요/);
    expect(String(d.options.detail)).toMatch(/\/U\/data\.replaced-20260925T010203Z/);
    expect(String(d.options.detail)).toMatch(/이전 판\(0\.3\.1\)/);
    expect(d.choices).toEqual(["quit", "download", "continue"]);
    expect(d.options.cancelId).toBe(0);
  });
  it("names 'the version you used before the update' when fromBuild is null or the snapshot is gone", () => {
    expect(String(holdDialog({ journal, snapshot: info({ fromBuild: null }), replacedDir: "/r" }, fmt).options.detail)).toMatch(/업데이트 전에 쓰던 판/);
    expect(String(holdDialog({ journal, snapshot: null, replacedDir: "/r" }, fmt).options.detail)).toMatch(/업데이트 전에 쓰던 판/);
  });
  it("releases page url", () => expect(RELEASES_PAGE_URL).toBe("https://github.com/Yjason-K/Damwha/releases"));
});

describe("pause env and io tracker", () => {
  it("parses only known steps", () => {
    expect(parsePauseStep("staged")).toBe("staged");
    expect(parsePauseStep("moved-aside")).toBe("moved-aside");
    expect(parsePauseStep("bogus")).toBeNull();
    expect(parsePauseStep(undefined)).toBeNull();
  });
  it("afterIo does not start stopping services until a tracked clone has finished", async () => {
    const t = createIoTracker();
    const order: string[] = [];
    void t.track(new Promise<void>((resolve) => setTimeout(() => { order.push("clone done"); resolve(); }, 20)));
    await afterIo(t, async () => { order.push("stop services"); });
    expect(order).toEqual(["clone done", "stop services"]);
  });
  it("settled waits for tracked work, including rejected work", async () => {
    const t = createIoTracker();
    let done = false;
    void t.track(new Promise<void>((resolve) => setTimeout(() => { done = true; resolve(); }, 20)));
    void t.track(Promise.reject(new Error("x"))).catch(() => undefined);
    await t.settled();
    expect(done).toBe(true);
  });
});
