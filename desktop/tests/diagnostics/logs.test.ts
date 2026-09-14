import { describe, expect, it } from "vitest";
import { LOG_GENERATIONS, LOG_MAX_BYTES, rotateIfNeeded, stripAnsi } from "../../src/diagnostics/logs";

function fakeIo(sizes: Record<string, number>) {
  const files = new Map(Object.entries(sizes));
  return {
    io: {
      size: (p: string) => files.get(p) ?? -1,
      rename: (from: string, to: string) => {
        const s = files.get(from);
        if (s === undefined) return;
        files.delete(from);
        files.set(to, s);
      },
      remove: (p: string) => files.delete(p),
    },
    files,
  };
}

describe("rotateIfNeeded", () => {
  it("does nothing below the threshold", () => {
    const { io, files } = fakeIo({ "/l/api.log": 10 });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect([...files.keys()]).toEqual(["/l/api.log"]);
  });

  it("does nothing when the file does not exist", () => {
    const { io, files } = fakeIo({});
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.size).toBe(0);
  });

  it("moves the current file to .1 when it is too big", () => {
    const { io, files } = fakeIo({ "/l/api.log": 500 });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.has("/l/api.log")).toBe(false);
    expect(files.get("/l/api.log.1")).toBe(500);
  });

  it("shifts older generations down", () => {
    const { io, files } = fakeIo({ "/l/api.log": 500, "/l/api.log.1": 400, "/l/api.log.2": 300 });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.get("/l/api.log.1")).toBe(500);
    expect(files.get("/l/api.log.2")).toBe(400);
    expect(files.get("/l/api.log.3")).toBe(300);
  });

  it("drops the oldest generation instead of growing without bound", () => {
    const { io, files } = fakeIo({
      "/l/api.log": 500,
      "/l/api.log.1": 400,
      "/l/api.log.2": 300,
      "/l/api.log.3": 200,
    });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.has("/l/api.log.4")).toBe(false);
    expect(files.get("/l/api.log.3")).toBe(300);
  });

  it("never throws when the filesystem refuses", () => {
    const io = {
      size: () => 500,
      rename: () => {
        throw new Error("EACCES");
      },
      remove: () => {
        throw new Error("EACCES");
      },
    };
    // 로그를 못 돌리는 것은 앱이 죽을 이유가 아니다 (Phase 1의 makeSink와 같은 규칙).
    expect(() => rotateIfNeeded("/l/api.log", 100, 3, io)).not.toThrow();
  });
});

describe("stripAnsi", () => {
  it("removes the worker's progress-bar colour", () => {
    // worker는 진행 바와 로그가 같은 stderr를 쓴다(console.install_logging).
    expect(stripAnsi("\x1b[32m진행 50%\x1b[0m")).toBe("진행 50%");
  });

  it("leaves plain text alone", () => {
    expect(stripAnsi("supervisor ready")).toBe("supervisor ready");
  });
});

describe("defaults", () => {
  it("are the values the spec records", () => {
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(LOG_GENERATIONS).toBe(3);
  });
});
