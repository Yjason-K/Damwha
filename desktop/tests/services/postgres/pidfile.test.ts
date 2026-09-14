import { describe, expect, it } from "vitest";
import { classifyLockOwner, parsePostmasterPid } from "../../../src/services/postgres/pidfile";

const PGDATA = "/Users/someone/Library/Application Support/Damwha/data/postgres";
const pidfile = (status: string) =>
  ["4242", PGDATA, "1757800000", "5432", "/Users/someone/Library/Application Support/Damwha/run", "", "  5432001    65536", status, ""].join("\n");

describe("parsePostmasterPid", () => {
  it("reads pid, data directory and the padded status line", () => {
    expect(parsePostmasterPid(pidfile("ready   "))).toEqual({ pid: 4242, dataDir: PGDATA, status: "ready" });
    expect(parsePostmasterPid(pidfile("starting"))).toMatchObject({ status: "starting" });
    expect(parsePostmasterPid(pidfile("stopping"))).toMatchObject({ status: "stopping" });
  });

  it("reports unknown while the postmaster has not written the status line yet", () => {
    expect(parsePostmasterPid(["4242", PGDATA, "1757800000"].join("\n"))).toMatchObject({ pid: 4242, status: "unknown" });
  });

  it("returns null for a file whose first line is not a pid", () => {
    for (const bad of ["", "abc\n", "-1\n", "0\n"]) expect(parsePostmasterPid(bad)).toBeNull();
  });
});

describe("classifyLockOwner — 기동 2단계 (스펙 §6.4)", () => {
  it("none when the pid is not running — PostgreSQL clears that lock itself", () => {
    expect(classifyLockOwner(PGDATA, null, 4242)).toEqual({ kind: "none" });
  });

  it("orphan for a postgres of any bundle path holding our data directory (dev and packaged share the cluster)", () => {
    for (const bin of ["/Applications/Damwha.app/Contents/Resources/postgres/bin/postgres", "/Users/x/project/daewha/desktop/build/postgres/bin/postgres"]) {
      expect(classifyLockOwner(PGDATA, { comm: bin, args: `${bin} -D ${PGDATA} -c listen_addresses=` }, 4242)).toEqual({ kind: "orphan", pid: 4242 });
      expect(classifyLockOwner(PGDATA, { comm: bin, args: `${bin} -D ${PGDATA}` }, 4242)).toEqual({ kind: "orphan", pid: 4242 });
    }
  });

  it("stale for a reused pid — another program, or a postgres on another data directory", () => {
    expect(classifyLockOwner(PGDATA, { comm: "/usr/bin/vim", args: "vim notes.txt" }, 4242)).toEqual({ kind: "stale", pid: 4242 });
    expect(classifyLockOwner(PGDATA, { comm: "/opt/homebrew/bin/postgres", args: "/opt/homebrew/bin/postgres -D /opt/homebrew/var/postgresql@16" }, 4242)).toEqual({ kind: "stale", pid: 4242 });
  });

  it("does not take a longer data directory that merely starts with ours", () => {
    const args = `/b/postgres -D ${PGDATA}-copy -c port=5432`;
    expect(classifyLockOwner(PGDATA, { comm: "/b/postgres", args }, 4242)).toEqual({ kind: "stale", pid: 4242 });
  });
});
