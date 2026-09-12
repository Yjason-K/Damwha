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
    // handle(1)이다. 목의 alive()는 `++calls <= aliveFor`라 handle(0)은 **첫 호출부터**
    // false — 즉 "이미 죽어 있는 핸들"이지 "예의 바르게 멈추는 worker"가 아니다.
    // handle(1)은 진입 시점에 살아 있고 그 다음 확인에서 죽는다. 이 구분이 있어야
    // 진입 가드(pid가 재사용됐을 수 있는 죽은 핸들에 신호를 쏘지 않는다)를 살릴 수 있다.
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(1), {
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
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: ask,
      maxWaits: 2,
    });
    expect(ask).toHaveBeenCalled();
    expect(signals.filter(([, s]) => s === "SIGKILL")).toHaveLength(0);
    // 거절한 시점의 프로세스는 방금 살아 있다고 확인된 프로세스다. stopped:false만으로는
    // 화면이 "깨끗하지 않다"고만 말하고 무엇을 죽여야 하는지는 말하지 못한다 (types.ts:67).
    expect(out).toEqual({ stopped: false, leaked: [4242] });
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
      // 여기서 stillAlive를 주는 이유는 단정이 아니라 격리다. 기본 구현은 핸들이 답해 줄 수
      // 없는 자손 pid를 signal 0으로 확인하는데, 5001·5002는 이 기계에 실제로 존재할 수
      // 있는 번호다 — 테스트가 진짜 프로세스를 건드리지 않게 가짜를 주입한다.
      stillAlive: async () => [],
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
    // 진입 가드(1콜) + 1단계 대기(2회 폴 + 마지막 확인 = 3콜) + 3단계 대기(같은 모양 = 3콜)
    // 뒤, 4단계 SIGKILL 스윕 직후의 5단계 확인이 정확히 8번째 콜이다. aliveFor=7이면 그
    // 8번째 콜에서 처음으로 false가 나와 "스윕이 방금 끝장냈다"를 흉내 낸다.
    const out = await stopWorkerProcess(handle(7), {
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

  // 아래 세 테스트는 "supervisor가 스스로 죽었다"는 경우를 본다. 그때 --once 자식과 그
  // 자식이 띄운 mlx_lm.server는 pid 1로 재부모화되어 사후 ppid BFS로는 보이지 않는다 —
  // 그래서 진입 시점에 자손을 한 번 찍어 두지 않으면 이 모듈은 고아를 남겨 두고도
  // {stopped:true, leaked:[]}를 보고한다. 정확히 이 설계가 막으려던 것이다.
  it("does not call it clean when a descendant captured at entry outlives stage 1", async () => {
    const alive = new Set([5001]);
    const out = await stopWorkerProcess(handle(1), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      // supervisor가 살아 있는 진입 시점에만 이 자식이 보인다. 1단계 대기 중 supervisor가
      // 스스로 죽으면(handle(1)) 그 뒤의 BFS는 빈 집합을 돌려준다.
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => {
        throw new Error("1단계에서 끝났으니 물을 일이 없다");
      },
      stillAlive: async (pids) => pids.filter((p) => alive.has(p)),
    });
    expect(out).toEqual({ stopped: false, leaked: [5001] });
  });

  it("does not call it clean when a descendant captured at entry outlives stage 3", async () => {
    // 진입 가드 1콜 + 1단계 대기 3콜 = 4콜까지 살아 있다가, 3단계 첫 확인(5번째 콜)에서
    // 죽는다 — supervisor는 두 번째 SIGTERM 뒤 사라졌는데 자식은 남은 모양이다.
    const alive = new Set([5001]);
    const out = await stopWorkerProcess(handle(4), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async (pids) => pids.filter((p) => alive.has(p)),
    });
    expect(out).toEqual({ stopped: false, leaked: [5001] });
  });

  it("still reports a clean stop when the captured descendants went with it", async () => {
    // 같은 경로인데 자손도 같이 죽은 경우. 스냅샷 확인이 늘 leaked를 만들어 내면
    // 평범한 종료마다 거짓 경고가 뜬다 — leaked는 사람에게 보여 주는 값이라 그러면 안 된다.
    const out = await stopWorkerProcess(handle(1), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => true,
      stillAlive: async () => [],
    });
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("refuses to signal a handle that is already dead at entry", async () => {
    // alive()는 `code === null`이라 자식이 끝나고 Node가 거둬들인 뒤에만 false가 된다 —
    // 바로 그 순간부터 OS가 그 pid를 재사용할 수 있다. 며칠씩 켜 두는 앱에서 죽은 핸들에
    // signal(-pid)를 쏘면 남의 프로세스 그룹을 때린다.
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(0), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
    });
    expect(signals).toEqual([]);
    expect(out).toEqual({ stopped: true, leaked: [] });
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

  it("asks once, keeping BOTH promises, when both are in flight", async () => {
    const ask = vi.fn(async (_message: string) => true);
    await decideQuit({ recording: true, analysing: true }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    const message = ask.mock.calls[0][0];
    expect(message).toMatch(/녹음/);
    expect(message).toMatch(/분석/);
    // 이름만 부르는 것으로는 부족하다. 둘 다 진행 중일 때 약속을 삼항으로 고르면 분석 쪽
    // 문장이 통째로 사라지는데, /녹음/·/분석/만 보는 단정은 그 손실을 보지 못한다 —
    // "녹음이 진행 중이에요, 분석이 진행 중이에요"에 이미 두 낱말이 다 들어 있기 때문이다.
    // 사용자가 다시 큐에 들어간다는 보장을 가장 필요로 하는 경우가 바로 이 경우다.
    expect(message).toMatch(/녹음을 먼저 안전하게 마무리합니다/);
    expect(message).toMatch(/다시 큐에 넣습니다/);
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
