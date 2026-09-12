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

  // Finding 1 (재리뷰): processExists(기본 자손 생존 확인)는 실제 호출자가 쓰는 유일한
  // 경로인데, 자손이 있는 기존 테스트는 전부 stillAlive를 주입해 이 기본 분기를 우회한다.
  // 재리뷰가 실측한 변이 두 종 — (a) process.kill이 안 던질 때의 `return true`를 false로,
  // (b) catch의 `code !== "ESRCH"`를 뒤집어 EPERM(존재하지만 남의 것)을 죽음으로 읽게 —
  // 둘 다 기존 21개 테스트를 초록불로 통과시켰다. 아래 두 테스트가 각각 하나씩 잡는다.
  it("treats a real, still-running descendant as alive through the default probe", async () => {
    // 실제 신호를 보내지 않는다 — process.kill(pid, 0)은 신호를 배달하지 않고 존재만
    // 묻는다. 자기 자신의 pid(현재 이 vitest 프로세스)를 자손인 척 주입하면 항상 진짜
    // "살아 있다"를 모형화할 수 있다. 이 경로가 변이 (a)를 잡는다: process.kill이 던지지
    // 않을 때 true 대신 false를 돌려주면 이 pid가 leaked에서 사라진다.
    const out = await stopWorkerProcess(handle(1), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([process.pid]),
      onGraceExpired: async () => {
        throw new Error("1단계에서 끝났으니 물을 일이 없다");
      },
    });
    expect(out).toEqual({ stopped: false, leaked: [process.pid] });
  });

  it("does not read a permission-denied descendant as dead", async () => {
    // EPERM(존재하지만 남의 프로세스)을 이식성 있게 실제로 재현하기는 어렵다 — 루트로
    // 도는 CI는 아예 안 던진다. process.kill을 흉내 내되, 어떤 pid로도 실제 커널 호출을
    // 하지 않는다(신호 0은 원래도 아무것도 배달하지 않지만, 이 테스트는 그마저도 안 부른다).
    // 이 경로가 변이 (b)를 잡는다: catch의 ESRCH 판정이 뒤집히면 EPERM이 "죽음"으로 읽혀
    // 이 pid가 leaked에서 사라진다.
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    try {
      const out = await stopWorkerProcess(handle(1), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => new Set([9999]),
        onGraceExpired: async () => {
          throw new Error("1단계에서 끝났으니 물을 일이 없다");
        },
      });
      expect(out).toEqual({ stopped: false, leaked: [9999] });
    } finally {
      spy.mockRestore();
    }
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

  it("catches a descendant that appears only in the re-snapshot taken right before the forced SIGTERM", async () => {
    // worker의 --once 자식은 job마다 새로 뜬다. 진입 스냅샷 이후, 강제 단계(3단계) 직전에
    // 새로 뜬 자식은 진입 스냅샷 하나만으로는 안 보인다. handle(4)는 바로 그 강제 단계의
    // 두 번째 SIGTERM 직후 죽으므로 cleanUnlessOrphans가 참고하는 것은 "지금까지 찍어 둔
    // 스냅샷들"뿐이다 — 그 자손이 stage 4의 사후 BFS에 잡힐 기회조차 없다. 강제 단계 직전
    // 재스냅샷이 없으면 이 경우는 {stopped:true, leaked:[]}로 뭉개진다 — 정확히 이
    // 테스트가 지키는 것이다.
    const alive = new Set([6001]);
    let call = 0;
    const out = await stopWorkerProcess(handle(4), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => {
        call += 1;
        // 1번째 호출(진입 스냅샷)에는 아직 없다. 2번째 호출(강제 단계 직전 재스냅샷)부터
        // 보인다.
        return call === 1 ? new Set<number>() : new Set([6001]);
      },
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async (pids) => pids.filter((p) => alive.has(p)),
    });
    expect(out).toEqual({ stopped: false, leaked: [6001] });
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

  // Finding 3 (재리뷰, 이월): opts.descendants(pid).catch(() => new Set())가 열거 실패를
  // "자손 없음"으로 뭉개면 그 뒤로 이 모듈은 "깨끗하다"고 보고한다 — main.ts의
  // verifyOwnListener가 소유를 증명 못 할 때 "아니오"로 닫는 것과 정반대 방향의 편향이다.
  // 아래 두 테스트는 각각 진입 스냅샷과 강제 단계 직전 재스냅샷이 실패하는 경우를 본다.
  it("does not report clean when the entry snapshot could not be taken", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const out = await stopWorkerProcess(handle(1), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          throw new Error("ps 실패");
        },
        onGraceExpired: async () => {
          throw new Error("1단계에서 끝났으니 물을 일이 없다");
        },
      });
      // leaked는 비어 있다 — 어떤 pid가 남았는지조차 모른다. 그래도 stopped는 false다:
      // "확인 못 했다"를 "깨끗했다"로 보고하지 않는다.
      expect(out).toEqual({ stopped: false, leaked: [] });
      // StopOutcome에는 이유를 실을 자리가 없다 — 사라지지 않게 최소한 로그에는 남는다.
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not report clean when the re-snapshot before the forced SIGTERM could not be taken", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let call = 0;
      const out = await stopWorkerProcess(handle(4), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          call += 1;
          // 진입 스냅샷(1번째)은 정상이다. 강제 단계 직전 재스냅샷(2번째)만 실패한다.
          if (call === 2) throw new Error("ps 실패");
          return new Set<number>();
        },
        onGraceExpired: async () => true,
        maxWaits: 2,
      });
      expect(out).toEqual({ stopped: false, leaked: [] });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not report clean when the pre-SIGKILL tree walk (stage 4) could not be taken", async () => {
    // 앞의 두 테스트는 cleanUnlessOrphans(1·3단계 조기 반환) 경로만 태운다. 5단계 최종
    // 반환에도 같은 snapshotFailed 가드가 있는데, 그 갈래를 지워도 위 두 테스트는 계속
    // 초록불이다(cleanUnlessOrphans까지도 안 간다) — 이 테스트가 그 갈래를 직접 태운다.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let call = 0;
      const out = await stopWorkerProcess(handle(999), {
        graceMs: 10,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          call += 1;
          // 진입(1번째)·강제 단계 직전(2번째) 스냅샷은 정상이다. 4단계의 재확인용 트리
          // 걷기(3번째)만 실패한다.
          if (call === 3) throw new Error("ps 실패");
          return new Set<number>();
        },
        onGraceExpired: async () => true,
        maxWaits: 2,
        // 진짜 생존 여부와 무관하게 "아무것도 안 남았다"로 고정한다 — 실패했는데도
        // stopped:true가 나온다면 그건 순전히 5단계 가드가 빠졌기 때문이어야 한다.
        stillAlive: async () => [],
      });
      expect(out).toEqual({ stopped: false, leaked: [] });
    } finally {
      spy.mockRestore();
    }
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
