import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceFailure } from "../../../src/services/failure";
import { pgLayout, type PgLayout } from "../../../src/services/postgres/layout";
import { clearPostmasterLock, type LockDeps } from "../../../src/services/postgres/lock";

let root: string;
let layout: PgLayout;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-lock-"));
  layout = pgLayout(path.join(root, "ud"));
  fs.mkdirSync(layout.pgdata, { recursive: true });
  fs.mkdirSync(layout.runDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const pidfile = (pid: number) =>
  fs.writeFileSync(path.join(layout.pgdata, "postmaster.pid"), [String(pid), layout.pgdata, "0", "5432", layout.runDir, "", "", "ready   ", ""].join("\n"));
const ours = (): LockDeps["psInfo"] => async () => ({ comm: "/B/postgres/bin/postgres", args: `/B/postgres/bin/postgres -D ${layout.pgdata}` });

function deps(over: Partial<LockDeps> = {}): LockDeps & { lines: string[]; stopped: number[] } {
  const lines: string[] = [];
  const stopped: number[] = [];
  return { layout, psInfo: async () => null, stopOrphan: async (pid) => (stopped.push(pid), "fast"), log: (l) => void lines.push(l), lines, stopped, ...over };
}

describe("clearPostmasterLock", () => {
  it("does nothing without a pid file", async () => {
    const d = deps();
    await clearPostmasterLock(d);
    expect(d.stopped).toEqual([]);
  });
  it("stops our orphan postmaster", async () => {
    pidfile(4242);
    const d = deps({ psInfo: ours() });
    await clearPostmasterLock(d);
    expect(d.stopped).toEqual([4242]);
  });
  it("refuses when the orphan leaks", async () => {
    pidfile(4242);
    await expect(clearPostmasterLock(deps({ psInfo: ours(), stopOrphan: async () => "leaked" }))).rejects.toBeInstanceOf(ServiceFailure);
  });
  it("removes a stale lock whose pid was reused", async () => {
    pidfile(4242);
    fs.writeFileSync(`${layout.socketFile}.lock`, "x");
    await clearPostmasterLock(deps({ psInfo: async () => ({ comm: "/usr/bin/vim", args: "vim" }) }));
    expect(fs.existsSync(path.join(layout.pgdata, "postmaster.pid"))).toBe(false);
    expect(fs.existsSync(`${layout.socketFile}.lock`)).toBe(false);
  });
  it("refuses and deletes nothing when ps fails", async () => {
    pidfile(4242);
    await expect(clearPostmasterLock(deps({ psInfo: async () => { throw new Error("ps timed out"); } }))).rejects.toBeInstanceOf(ServiceFailure);
    expect(fs.existsSync(path.join(layout.pgdata, "postmaster.pid"))).toBe(true);
  });
});
