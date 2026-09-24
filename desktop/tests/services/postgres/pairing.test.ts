import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideCluster,
  decideDatabase,
  parseControldataClusterId,
  parseControldataState,
  parseMarker,
  readStorageFacts,
  serializeMarker,
  writeMarkerAtomic,
  type ClusterFacts,
} from "../../../src/services/postgres/pairing";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pair-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const MARK = serializeMarker({ clusterId: "7412345678901234567", databaseOid: 16384 });
const facts = (over: Partial<ClusterFacts>): ClusterFacts => ({
  pgdataExists: true,
  pgVersion: "16",
  clusterId: "7412345678901234567",
  storage: { markerText: MARK, hasFiles: true },
  ...over,
});

describe("marker", () => {
  it("round-trips", () => {
    expect(parseMarker(serializeMarker({ clusterId: "1", databaseOid: null }))).toEqual({ clusterId: "1", databaseOid: null });
    expect(parseMarker(MARK)).toEqual({ clusterId: "7412345678901234567", databaseOid: 16384 });
  });

  it("rejects anything that is not exactly the marker shape", () => {
    for (const bad of ["", "{", "[]", "null", '{"clusterId":7}', '{"clusterId":"1"}', '{"clusterId":"1","databaseOid":"16384"}', '{"clusterId":"","databaseOid":null}', '{"clusterId":"1","databaseOid":0}']) {
      expect(parseMarker(bad)).toBeNull();
    }
  });

  it("writes atomically and creates the storage directory", () => {
    const marker = path.join(dir, "storage", ".damwha-cluster");
    writeMarkerAtomic(marker, { clusterId: "42", databaseOid: null });
    expect(parseMarker(fs.readFileSync(marker, "utf8"))).toEqual({ clusterId: "42", databaseOid: null });
    expect(fs.readdirSync(path.dirname(marker))).toEqual([".damwha-cluster"]);
  });
});

describe("readStorageFacts", () => {
  it("treats a missing directory as empty", () => {
    expect(readStorageFacts(path.join(dir, "nope"))).toEqual({ markerText: null, hasFiles: false });
  });

  it("does not count the marker or .DS_Store as files", () => {
    fs.writeFileSync(path.join(dir, ".damwha-cluster"), MARK);
    fs.writeFileSync(path.join(dir, ".DS_Store"), "x");
    expect(readStorageFacts(dir)).toEqual({ markerText: MARK, hasFiles: false });
  });

  it("counts anything else, including an empty meetings/ directory", () => {
    fs.mkdirSync(path.join(dir, "meetings"));
    expect(readStorageFacts(dir).hasFiles).toBe(true);
  });
});

describe("parseControldataClusterId", () => {
  it("reads the id from the C-locale label", () => {
    const out = "pg_control version number:            1300\nDatabase system identifier:           7412345678901234567\nDatabase cluster state:               shut down\n";
    expect(parseControldataClusterId(out)).toBe("7412345678901234567");
  });

  it("returns null when the label is missing", () => {
    expect(parseControldataClusterId("Datenbanksystemidentifikation: 1\n")).toBeNull();
  });
});

describe("decideCluster — 판정표 1 (스펙 §6.2)", () => {
  it("initdb when there is no cluster and nothing in storage (marker from an interrupted run does not matter)", () => {
    expect(decideCluster(facts({ pgdataExists: false, storage: { markerText: null, hasFiles: false } }))).toEqual({ kind: "initdb" });
    expect(decideCluster(facts({ pgdataExists: false, storage: { markerText: MARK, hasFiles: false } }))).toEqual({ kind: "initdb" });
  });

  it("refuses storage with files but no cluster — a fresh cluster would reuse mtg_1… over those files", () => {
    expect(decideCluster(facts({ pgdataExists: false }))).toMatchObject({ kind: "refuse", reason: "storage-without-cluster" });
  });

  it("refuses a cluster without a marker even when storage is empty — the app writes the marker before the cluster exists", () => {
    expect(decideCluster(facts({ storage: { markerText: null, hasFiles: false } }))).toMatchObject({ kind: "refuse", reason: "cluster-without-marker" });
  });

  it("refuses an unreadable marker", () => {
    expect(decideCluster(facts({ storage: { markerText: "{", hasFiles: true } }))).toMatchObject({ kind: "refuse", reason: "marker-unreadable" });
  });

  it("refuses a marker from another cluster", () => {
    expect(decideCluster(facts({ clusterId: "999" }))).toMatchObject({ kind: "refuse", reason: "marker-mismatch" });
  });

  it("refuses another major version before reading the control file", () => {
    expect(decideCluster(facts({ pgVersion: "15", clusterId: null }))).toEqual({ kind: "refuse", reason: "version-mismatch", detail: "15" });
    expect(decideCluster(facts({ pgVersion: null, clusterId: null }))).toEqual({ kind: "refuse", reason: "version-mismatch", detail: null });
  });

  it("refuses a cluster whose control file could not be read", () => {
    expect(decideCluster(facts({ clusterId: null }))).toMatchObject({ kind: "refuse", reason: "controldata-failed" });
  });

  it("starts a matching cluster and hands over the marker", () => {
    expect(decideCluster(facts({}))).toEqual({ kind: "start", marker: { clusterId: "7412345678901234567", databaseOid: 16384 } });
  });
});

describe("decideDatabase — 판정표 2 (스펙 §6.2)", () => {
  const m = (databaseOid: number | null) => ({ clusterId: "1", databaseOid });

  it("creates the database only when nothing says one existed", () => {
    expect(decideDatabase({ oid: null, marker: m(null), storageHasFiles: false })).toEqual({ kind: "createdb" });
  });

  it("refuses a missing database when storage has files", () => {
    expect(decideDatabase({ oid: null, marker: m(null), storageHasFiles: true })).toMatchObject({ kind: "refuse", reason: "storage-without-database" });
  });

  it("refuses a dropped database — the marker remembers it", () => {
    expect(decideDatabase({ oid: null, marker: m(16384), storageHasFiles: false })).toMatchObject({ kind: "refuse", reason: "database-dropped" });
  });

  it("records the oid when createdb finished but the marker was not yet written", () => {
    expect(decideDatabase({ oid: 16384, marker: m(null), storageHasFiles: false })).toEqual({ kind: "record-oid", oid: 16384 });
  });

  it("refuses an unrecorded database next to files", () => {
    expect(decideDatabase({ oid: 16384, marker: m(null), storageHasFiles: true })).toMatchObject({ kind: "refuse", reason: "storage-without-database" });
  });

  it("passes the database the marker names", () => {
    expect(decideDatabase({ oid: 16384, marker: m(16384), storageHasFiles: true })).toEqual({ kind: "ok" });
  });

  it("refuses a recreated database", () => {
    expect(decideDatabase({ oid: 20000, marker: m(16384), storageHasFiles: false })).toMatchObject({ kind: "refuse", reason: "database-recreated" });
  });
});

describe("parseControldataState", () => {
  it("reads the cluster state line", () => {
    const out = "Database system identifier:           7687238228739395787\nDatabase cluster state:               shut down\n";
    expect(parseControldataState(out)).toBe("shut down");
    expect(parseControldataState("Database cluster state:               in production\n")).toBe("in production");
  });
  it("returns null without the line", () => expect(parseControldataState("nothing")).toBeNull());
});
