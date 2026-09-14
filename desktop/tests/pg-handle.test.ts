import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postmasterArgs, spawnPostmaster, stopPostmaster, type PostmasterSignal } from "../src/services/pg-handle";
import { pgBinaries, pgLayout } from "../src/services/pg-layout";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeProcess(diesOn: PostmasterSignal | null) {
  let alive = true;
  const sent: string[] = [];
  return {
    sent,
    deps: {
      pollMs: 5,
      alive: () => alive,
      signal: (_pid: number, sig: PostmasterSignal) => {
        sent.push(sig);
        if (sig === diesOn) alive = false;
      },
    },
  };
}

describe("stopPostmaster", () => {
  it("stops on SIGINT (fast shutdown) and sends nothing else", async () => {
    const p = fakeProcess("SIGINT");
    expect(await stopPostmaster(4242, 200, 200, p.deps)).toBe("fast");
    expect(p.sent).toEqual(["SIGINT"]);
  });

  it("goes to SIGQUIT (immediate) when fast shutdown outlives its grace", async () => {
    const p = fakeProcess("SIGQUIT");
    expect(await stopPostmaster(4242, 30, 200, p.deps)).toBe("immediate");
    expect(p.sent).toEqual(["SIGINT", "SIGQUIT"]);
  });

  it("reports a leak rather than escalating further — never SIGKILL a postmaster", async () => {
    const p = fakeProcess(null);
    expect(await stopPostmaster(4242, 20, 20, p.deps)).toBe("leaked");
    expect(p.sent).toEqual(["SIGINT", "SIGQUIT"]);
  });

  it("does nothing for a process that is already gone, and refuses a pid it cannot trust", async () => {
    const gone = { pollMs: 5, alive: () => false, signal: vi.fn() };
    expect(await stopPostmaster(4242, 20, 20, gone)).toBe("fast");
    expect(gone.signal).not.toHaveBeenCalled();
    const p = fakeProcess("SIGINT");
    expect(await stopPostmaster(undefined, 20, 20, p.deps)).toBe("leaked");
    expect(await stopPostmaster(0, 20, 20, p.deps)).toBe("leaked");
    expect(p.sent).toEqual([]);
  });

  it("cannot even be asked to send SIGKILL", () => {
    // @ts-expect-error — PostmasterSignal에 SIGKILL이 없다. 이 줄이 컴파일되면 타입이 넓어진 것이다.
    const s: PostmasterSignal = "SIGKILL";
    expect(s).toBe("SIGKILL");
  });
});

describe("postmasterArgs", () => {
  it("opens no TCP listener, a private socket, and a server-written log", () => {
    const l = pgLayout("/U/Damwha");
    const a = postmasterArgs(l);
    expect(a.slice(0, 2)).toEqual(["-D", l.pgdata]);
    expect(a).toContain("listen_addresses=");
    expect(a).toContain(`unix_socket_directories=${l.runDir}`);
    expect(a).toContain("unix_socket_permissions=0700");
    expect(a).toContain("logging_collector=on");
    expect(a).toContain(`log_directory=${l.logDir}`);
  });
});

describe("spawnPostmaster", () => {
  it("spawns the bundle's postgres directly in its own group with the pinned tool env", () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill: vi.fn() });
    const spawnFn = vi.fn(() => child);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pm-"));
    try {
      const h = spawnPostmaster({
        binaries: pgBinaries("/B/postgres"),
        layout: pgLayout("/U/Damwha"),
        logFile: path.join(dir, "postgres.log"),
        immediateGraceMs: 10,
        spawnFn: spawnFn as never,
      });
      const [bin, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], { detached: boolean; env: Record<string, string> }];
      expect(bin).toBe("/B/postgres/bin/postgres");
      expect(args).not.toContain("start"); // pg_ctl start를 거치지 않는다 (Phase 0 규칙 2b)
      expect(opts.detached).toBe(true);
      expect(opts.env.LC_ALL).toBe("C");
      expect(h.pid).toBe(4242);
      child.stderr.emit("data", Buffer.from("FATAL: lock file exists\n"));
      expect(h.stderrTail()).toContain("lock file exists");
      child.emit("exit", 1, null);
      expect(h.alive()).toBe(false);
      expect(h.exitCode()).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops by signalling the postmaster pid only — no group, no SIGKILL", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill: vi.fn() });
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig: string) => {
      if (sig === "SIGINT") setTimeout(() => child.emit("exit", 0, null), 5);
      return true;
    }) as never);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pm-"));
    try {
      const h = spawnPostmaster({
        binaries: pgBinaries("/B/postgres"),
        layout: pgLayout("/U/Damwha"),
        logFile: path.join(dir, "postgres.log"),
        immediateGraceMs: 10,
        spawnFn: (() => child) as never,
      });
      await h.stop(500);
      expect(kill.mock.calls).toEqual([[4242, "SIGINT"]]);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps SIGKILL and group signals out of the source", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "pg-handle.ts"), "utf8");
    expect(src).not.toMatch(/SIGKILL/);
    expect(src).not.toMatch(/process\.kill\(\s*-/);
  });
});
