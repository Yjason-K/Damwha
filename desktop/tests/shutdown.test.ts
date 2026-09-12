import { describe, expect, it, vi } from "vitest";
import { decideQuit, runHandshake, stopWorkerProcess } from "../src/shutdown";

describe("stopWorkerProcess", () => {
  function handle(aliveFor: number) {
    let calls = 0;
    return {
      pid: 4242,
      alive: () => ++calls <= aliveFor,
      stderrTail: () => "",
      exitCode: () => null,
      onExit: () => undefined,
      stop: async () => undefined,
    } as never;
  }

  it("sends SIGTERM exactly once when the worker stops politely", async () => {
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(0), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
    });
    expect(signals).toEqual([[-4242, "SIGTERM"]]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("asks before escalating and does nothing more when the answer is no", async () => {
    const signals: Array<[number, string]> = [];
    const ask = vi.fn(async () => false);
    await stopWorkerProcess(handle(999), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: ask,
      maxWaits: 2,
    });
    expect(ask).toHaveBeenCalled();
    expect(signals.filter(([, s]) => s === "SIGKILL")).toHaveLength(0);
  });

  it("escalates with a SECOND SIGTERM, not SIGKILL", async () => {
    // supervisor의 2단계 핸들러가 두 번째 SIGTERM에서 자식을 kill하고 os._exit한다.
    // 우리가 곧장 SIGKILL을 보내면 --once 자식과 mlx_lm.server가 고아로 남는다.
    const signals: string[] = [];
    await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (_pid, sig) => signals.push(sig),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(signals[0]).toBe("SIGTERM");
    expect(signals[1]).toBe("SIGTERM");
  });

  it("finally SIGKILLs the descendant set, which crosses the new session", async () => {
    // --once 자식은 start_new_session이라 그룹 kill에 안 잡히지만 부모-자식 관계는
    // 그대로라 ps의 ppid BFS가 찾는다 (스펙 §6.9 4단계).
    const killed: number[] = [];
    await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (pid, sig) => {
        if (sig === "SIGKILL") killed.push(pid);
      },
      descendants: async () => new Set([5001, 5002]),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(killed.sort()).toEqual([4242, 5001, 5002]);
  });

  it("reports what it could not clean instead of claiming success", async () => {
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async () => [4242, 5001],
    });
    expect(out.stopped).toBe(false);
    expect(out.leaked.sort()).toEqual([4242, 5001]);
  });

  // 아래 두 테스트는 brief에는 없다. stillAlive를 주지 않으면 5단계가 handle.alive()만
  // 본다는 기본 경로(JSDoc의 "기본은 handle.alive()만 본다")는 위 테스트들 중 어느 것도
  // 반환값을 확인하지 않는다 — "escalates with a SECOND SIGTERM"과 "finally SIGKILLs..."는
  // signals/killed 배열만 보고 out은 버린다. 그래서 `handle.alive() ? [pid] : []`의 두
  // 갈래를 뒤집어도(mutate) 기존 15개 중 아무것도 빨개지지 않는다 — 직접 확인함(아래 보고).
  it("reports honest success through the default alive-check when the sweep actually finishes it off", async () => {
    // 1단계 대기(2회 폴 + 마지막 확인 = alive() 3콜) + 3단계 대기(같은 모양 = 3콜) 뒤,
    // 4단계 SIGKILL 스윕 직후의 5단계 확인이 정확히 7번째 콜이다. aliveFor=6이면 그 7번째
    // 콜에서 처음으로 false가 나와 "스윕이 방금 끝장냈다"를 흉내 낸다.
    const out = await stopWorkerProcess(handle(6), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("reports honest failure through the default alive-check when nothing kills it", async () => {
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(out).toEqual({ stopped: false, leaked: [4242] });
  });

  it("does nothing when there is no pid", async () => {
    const signals: string[] = [];
    const out = await stopWorkerProcess(
      { pid: undefined, alive: () => false } as never,
      {
        graceMs: 10,
        pollMs: 5,
        signal: (_p, s) => signals.push(s),
        descendants: async () => new Set<number>(),
        onGraceExpired: async () => true,
      },
    );
    expect(signals).toEqual([]);
    expect(out.stopped).toBe(true);
  });
});

describe("decideQuit", () => {
  it("asks when a recording is in flight", async () => {
    // 브리프 원문은 vi.fn(async () => true)였는데, decideQuit의 ask 시그니처가
    // (message: string) => Promise<boolean>>라 인자가 없는 함수로 추론되면
    // mock.calls[0][0] 인덱싱이 tsc(TS2493)에서 걸린다 — vitest는 esbuild로
    // transpile만 하므로 안 잡히지만, lint가 커버하지 않는 tests/를 따로 타입
    // 검사하면 드러난다. 파라미터 타입을 명시해 실제 시그니처와 맞춘다.
    const ask = vi.fn(async (_message: string) => true);
    const d = await decideQuit({ recording: true, analysing: false }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/녹음/);
    expect(d).toEqual({ quit: true, stopRecording: true });
  });

  it("asks when a job is running", async () => {
    const ask = vi.fn(async (_message: string) => true);
    const d = await decideQuit({ recording: false, analysing: true }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/분석/);
    expect(d).toEqual({ quit: true, stopRecording: false });
  });

  it("asks once, naming both, when both are in flight", async () => {
    const ask = vi.fn(async (_message: string) => true);
    await decideQuit({ recording: true, analysing: true }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/녹음/);
    expect(ask.mock.calls[0][0]).toMatch(/분석/);
  });

  it("does not ask when nothing is in flight", async () => {
    const ask = vi.fn(async () => true);
    const d = await decideQuit({ recording: false, analysing: false }, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(d).toEqual({ quit: true, stopRecording: false });
  });

  it("cancels the quit when the user says no", async () => {
    const d = await decideQuit({ recording: true, analysing: false }, async () => false);
    expect(d.quit).toBe(false);
  });
});

describe("runHandshake", () => {
  it("returns stopped when the renderer finishes", async () => {
    const r = await runHandshake(async () => ({ stopped: true }), { timeoutMs: 50 });
    expect(r).toEqual({ kind: "stopped" });
  });

  it("reports the renderer's own reason for failing", async () => {
    const r = await runHandshake(async () => ({ stopped: false, reason: "업로드 실패" }), {
      timeoutMs: 50,
    });
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.detail).toContain("업로드 실패");
  });

  it("times out instead of blocking the quit forever", async () => {
    const r = await runHandshake(() => new Promise(() => undefined), { timeoutMs: 20 });
    expect(r.kind).toBe("timeout");
  });

  it("treats a destroyed renderer as failed, not as success", async () => {
    const r = await runHandshake(async () => {
      throw new Error("Object has been destroyed");
    }, { timeoutMs: 50 });
    expect(r.kind).toBe("failed");
  });
});
