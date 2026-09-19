import { describe, expect, it, vi } from "vitest";
import { leftoverNotice } from "../../src/app/quit-flow";
import { stopThenReap } from "../../src/app/reap-on-quit";
import { knownTrees, type ReapDeps } from "../../src/process/orphans";
import { judgeAfterProbe } from "../../src/services/api";
import { ServiceFailure } from "../../src/services/failure";
import { STALL_MS } from "../../src/services/model-readiness";
import { createSupervisor, orderOf, restartRefused } from "../../src/services/supervisor";
import type {
  LaunchContext,
  LaunchResult,
  ReadinessResult,
  ServiceId,
  ServiceSpec,
  StopOutcome,
} from "../../src/services/types";

function ctx(): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: false,
    databaseMode: "embedded",
    env: {},
    bins: { python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test",
    searchDirs: ["/opt/homebrew/bin"],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
  };
}

function spec(id: ServiceId, over: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    id,
    dependsOn: [],
    gate: true,
    detectExternal: async () => ({ kind: "absent" }),
    launch: async () => ({ handle: null, owned: true }),
    readiness: async () => ({ kind: "ready" }),
    stop: async () => ({ stopped: true, leaked: [] }),
    restart: "never",
    ...over,
  };
}

/**
 * onExit 리스너를 테스트가 쥐는 가짜 프로세스 핸들. 사망 시점을 테스트가 직접 정해야
 * 재시작 정책을 실시간 대기 없이 밟을 수 있다.
 */
function fakeHandle(capture: (listener: (code: number) => void) => void) {
  return {
    pid: 1,
    alive: () => true,
    stderrTail: () => "",
    exitCode: () => null,
    onExit: capture,
    stop: async () => undefined,
  } as never;
}

describe("orderOf", () => {
  it("puts a dependency before its dependant", () => {
    const order = orderOf([spec("api", { dependsOn: ["postgres"] }), spec("postgres")]);
    expect(order.map((s) => s.id)).toEqual(["postgres", "api"]);
  });

  it("keeps independent services in declaration order", () => {
    const order = orderOf([spec("embed"), spec("postgres")]);
    expect(order.map((s) => s.id)).toEqual(["embed", "postgres"]);
  });

  it("throws on a cycle instead of looping forever", () => {
    expect(() =>
      orderOf([
        spec("api", { dependsOn: ["worker"] }),
        spec("worker", { dependsOn: ["api"] }),
      ]),
    ).toThrow(/cycle/i);
  });
});

describe("supervisor.start", () => {
  it("merges prepare() output into the env before any launch", async () => {
    const seen: string[] = [];
    const s = createSupervisor(
      [
        spec("embed", { prepare: async () => ({ EMBED_SERVICE_PORT: "8123" }) }),
        spec("api", {
          dependsOn: ["embed"],
          launch: async (c) => {
            seen.push(c.env.EMBED_SERVICE_PORT ?? "missing");
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(seen).toEqual(["8123"]);
  });

  it("does not launch a service whose external policy stands down", async () => {
    const launch = vi.fn(async () => ({ handle: null, owned: true }));
    const s = createSupervisor(
      [
        spec("worker", {
          detectExternal: async () => ({ kind: "stand-down", detail: "외부 worker" }),
          launch,
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(launch).not.toHaveBeenCalled();
    const st = s.statuses().find((x) => x.id === "worker")!;
    expect(st.owned).toBe(false);
    expect(st.detail).toContain("외부 worker");
  });

  it("stops a gate service that never becomes ready and reports failed", async () => {
    const stop = vi.fn(async () => ({ stopped: true, leaked: [] }));
    const s = createSupervisor(
      [spec("api", { readiness: async () => ({ kind: "not-ready" }), stop })],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses()[0].process).toBe("failed");
    expect(stop).toHaveBeenCalled();
  });

  it("stops launching once a gate service fails", async () => {
    const later = vi.fn(async () => ({ handle: null, owned: true }));
    const s = createSupervisor(
      [
        spec("postgres", { readiness: async () => ({ kind: "failed", detail: "데몬 없음" }) }),
        spec("api", { dependsOn: ["postgres"], launch: later }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(later).not.toHaveBeenCalled();
    expect(s.statuses().find((x) => x.id === "api")!.process).toBe("stopped");
  });

  it("keeps going when a non-gate service is not ready", async () => {
    const s = createSupervisor(
      [
        spec("api"),
        spec("worker", { gate: false, dependsOn: ["api"], readiness: async () => ({ kind: "not-ready" }) }),
      ],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses().find((x) => x.id === "api")!.process).toBe("running");
    // worker의 준비 대기는 배경에서 돈다 — start()는 그것을 기다리지 않고 곧장 반환하므로
    // (바로 위 "does not block the start loop" 테스트가 그 성질 자체를 검증한다), worker가
    // readyTimeoutMs(30ms)를 실제로 다 써서 failed로 넘어갈 시간을 벌어 줘야 한다.
    await new Promise((r) => setTimeout(r, 50));
    expect(s.statuses().find((x) => x.id === "worker")!.process).toBe("failed");
  });

  it("records degraded without touching the process state", async () => {
    const s = createSupervisor(
      [spec("api", { readiness: async () => ({ kind: "degraded", detail: "DB 끊김" }) })],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    const st = s.statuses()[0];
    expect(st.process).toBe("running");
    expect(st.health).toBe("degraded");
    expect(st.detail).toBe("DB 끊김");
  });
});

describe("supervisor restart policy", () => {
  it("does not block the start loop on a non-gate service", async () => {
    // embed는 bge-m3를 import 시점에 올려 30초 이상 걸린다. 직렬로 기다리면 창이 그만큼
    // 늦게 뜬다 — 스펙 §6.7의 "게이트는 셋뿐"이 이 비대칭을 뜻한다.
    const order: ServiceId[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          readiness: async () => {
            await new Promise((r) => setTimeout(r, 200));
            return { kind: "ready" };
          },
          launch: async () => {
            order.push("embed");
            return { handle: null, owned: true };
          },
        }),
        spec("api", {
          launch: async () => {
            order.push("api");
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 2_000, readyIntervalMs: 10 },
    );
    await s.start();
    expect(order).toEqual(["embed", "api"]);
    // 여기가 이 성질을 잡는 단언이다. launch 호출 **순서**는 직렬 구현에서도 똑같으므로
    // order만으로는 아무것도 증명하지 못한다(직렬로 되돌려도 초록이었다). start()가 embed의
    // 200ms 준비를 기다렸다면 이 시점에 embed는 이미 running이다 — 아직 starting이라는 것이
    // 곧 기동 루프가 그것을 기다리지 않았다는 뜻이다.
    expect(s.statuses().find((x) => x.id === "embed")!.process).toBe("starting");
    expect(s.statuses().find((x) => x.id === "api")!.process).toBe("running");
  });

  it("relaunches after the process dies and counts the attempt", async () => {
    let launches = 0;
    let listener: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: true,
          restart: { maxAttempts: 2, backoffMs: [5] },
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => {
                  listener = l;
                },
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(launches).toBe(1);
    listener!(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(launches).toBe(2);
    expect(s.statuses()[0].restarts).toBe(1);
  });

  it("stops relaunching at maxAttempts instead of looping forever", async () => {
    let launches = 0;
    const listeners: Array<(code: number) => void> = [];
    const s = createSupervisor(
      [
        spec("worker", {
          restart: { maxAttempts: 2, backoffMs: [5] },
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => listeners.push(l),
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    for (let i = 0; i < 5; i += 1) {
      listeners.at(-1)?.(1);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(launches).toBe(3); // 최초 1 + 재시작 2
  });

  it("never restarts a service whose policy is never", async () => {
    // postgres. compose의 restart: unless-stopped가 이미 그 일을 한다.
    let launches = 0;
    let listener: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("postgres", {
          restart: "never",
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => {
                  listener = l;
                },
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    listener!(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(launches).toBe(1);
  });

  it("does not restart once stopAll has begun", async () => {
    // 종료가 방금 치운 것을 타이머가 되살리면 앱이 창 없이 프로세스만 남긴다.
    let launches = 0;
    let listener: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("worker", {
          restart: { maxAttempts: 3, backoffMs: [10] },
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => {
                  listener = l;
                },
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await s.stopAll({ graceMs: 5 });
    listener!(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(launches).toBe(1);
  });
});

describe("supervisor.stopAll", () => {
  it("stops in reverse dependency order", async () => {
    const order: ServiceId[] = [];
    const rec = (id: ServiceId) =>
      spec(id, {
        dependsOn: id === "postgres" ? [] : ["postgres"],
        stop: async () => {
          order.push(id);
          return { stopped: true, leaked: [] };
        },
      });
    const s = createSupervisor([rec("postgres"), rec("api"), rec("worker")], ctx(), {});
    await s.start();
    await s.stopAll({ graceMs: 10 });
    expect(order).toEqual(["worker", "api", "postgres"]);
  });

  it("never stops a service the app did not launch", async () => {
    const stop = vi.fn(async () => ({ stopped: true, leaked: [] }));
    const s = createSupervisor(
      [spec("embed", { detectExternal: async () => ({ kind: "adopt", detail: "외부" }), stop })],
      ctx(),
      {},
    );
    await s.start();
    await s.stopAll({ graceMs: 10 });
    expect(stop).not.toHaveBeenCalled();
  });

  it("collects leaked pids from every service", async () => {
    const s = createSupervisor(
      [
        spec("api", { stop: async () => ({ stopped: false, leaked: [111] }) }),
        spec("worker", { stop: async () => ({ stopped: false, leaked: [222, 333] }) }),
      ],
      ctx(),
      {},
    );
    await s.start();
    const out = await s.stopAll({ graceMs: 10 });
    expect(out.leaked.sort()).toEqual([111, 222, 333]);
  });

  it("carries each service's reason out, not just the fact that it was not clean", async () => {
    // detail을 버리면 종료 대화상자가 "고아가 살아 있다"와 "확인하지 못했다"와 "사람이
    // 강제를 거절했다"를 같은 말로 적게 된다 — 어댑터가 애써 구분한 것이 여기서 사라진다.
    const s = createSupervisor(
      [
        spec("api", { stop: async () => ({ stopped: true, leaked: [] }) }),
        spec("worker", {
          stop: async () => ({ stopped: false, leaked: [222], detail: "아직 살아 있어요." }),
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    const out = await s.stopAll({ graceMs: 10 });
    expect(out.detail).toBe("아직 살아 있어요.");
  });

  it("says nothing extra when every service stopped cleanly", async () => {
    const s = createSupervisor([spec("api"), spec("worker")], ctx(), {});
    await s.start();
    expect((await s.stopAll({ graceMs: 10 })).detail).toBeUndefined();
  });

  it("puts a throwing stop on the screen, not only in the log", async () => {
    // 던지는 stop은 leaked도 비어 있어서 그 자리가 완전히 말이 없다 — 화면은 "깨끗하지
    // 않다"만 말하고 무엇이 왜 실패했는지는 로그 파일을 열어야만 알 수 있었다.
    const s = createSupervisor(
      [
        spec("worker", {
          stop: async () => {
            throw new Error("boom");
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    const out = await s.stopAll({ graceMs: 10 });
    expect(out.stopped).toBe(false);
    expect(out.detail).toContain("worker");
    expect(out.detail).toContain("boom");
  });

  it("keeps stopping the rest when one service's stop throws", async () => {
    const stopped: ServiceId[] = [];
    const s = createSupervisor(
      [
        spec("api", {
          stop: async () => {
            stopped.push("api");
            return { stopped: true, leaked: [] };
          },
        }),
        spec("worker", {
          dependsOn: ["api"],
          stop: async () => {
            throw new Error("boom");
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    await s.stopAll({ graceMs: 10 });
    expect(stopped).toEqual(["api"]);
  });
});

describe("supervisor.stopAll → 종료 회수 (B층, P4-C19)", () => {
  it("never calls a dead worker's stop() — and the quit chain still reaps what it left and turns A's clean into not-clean", async () => {
    // 스펙 §6.5: watchForDeath가 rt.result를 null로 만들고 stopAll이 그 서비스를 건너뛴다. 그래서 stop() 안에
    // 무엇을 넣어도 이 경로에서는 돌지 않는다 — B층이 따로 있는 이유다. 그 경로를 흉내 내지 않고 실제로 밟고,
    // main.ts의 stopServices()가 쓰는 사슬(stopThenReap: stopAll 뒤 B층, 판정 합치기)을 그대로 돌린다.
    const RUN = "desktop-33333333-3333-4333-8333-333333333333";
    const c: LaunchContext = { ...ctx(), runId: RUN };
    const py = c.bins.python;
    let workerStopCalls = 0;
    let die: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: true,
          // 실제 worker처럼 재시작 정책이 있다. 재시작 타이머는 stopAll이 치운다.
          restart: { maxAttempts: 3, backoffMs: [60_000] },
          launch: async () => ({
            handle: fakeHandle((listener) => {
              die = listener;
            }),
            owned: true,
          }),
          stop: async () => {
            workerStopCalls += 1;
            return { stopped: true, leaked: [] };
          },
        }),
      ],
      c,
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.runtimeOf("worker")!.result).not.toBeNull();

    // Python supervisor만 kill -9. start_new_session=True인 --once(7002)와 그 아래 llm_entry(7003)는
    // 이번 실행의 run-id를 단 채 launchd 아래로 재부모화돼 산다 (P4-C19 a).
    die!(137);
    expect(s.runtimeOf("worker")!.result).toBeNull();

    const alive = new Set([1, 7002, 7003]);
    const events: string[] = [];
    const logs: string[] = [];
    const ps = [
      "  PID ARGS",
      "    1 /sbin/launchd",
      ` 7002 ${py} -m damwha_worker --once --run-id=${RUN}`,
      ` 7003 ${py} -m damwha_worker.llm_entry --run-id=${RUN} --model mlx-community/Qwen3-4B-4bit --port 51234`,
    ].join("\n");
    const deps: ReapDeps = {
      runId: c.runId,
      trees: knownTrees(c),
      ps: async () => {
        events.push("B:ps");
        return ps;
      },
      descendantsOf: async (pid) => (pid === 7002 && alive.has(7003) ? [7003] : []),
      kill: (pid) => {
        events.push(`KILL ${pid}`);
        alive.delete(pid);
      },
      terminate: (pid) => {
        events.push(`TERM ${pid}`);
        alive.delete(pid);
      },
      exists: (pid) => alive.has(pid),
      log: (line) => logs.push(line),
      sleep: async () => undefined,
    };

    let layerA: StopOutcome | null = null;
    const out = await stopThenReap(async () => {
      events.push("A:stopAll");
      layerA = await s.stopAll({ graceMs: 10 });
      events.push("A:done");
      return layerA;
    }, deps);

    expect(workerStopCalls).toBe(0);
    // A층은 깨끗하다고 보고한다 — 핸들이 없으니 볼 것이 없었다. status는 failed로 남는다(건너뛰었다).
    expect(layerA).toEqual({ stopped: true, leaked: [] });
    expect(s.statuses()[0].process).toBe("failed");
    // B층은 A층이 끝난 뒤에, 자손 먼저 내린다. launchd(1)와 죽은 supervisor에는 신호가 없다.
    expect(events).toEqual(["A:stopAll", "A:done", "B:ps", "TERM 7003", "TERM 7002"]);
    expect(alive).toEqual(new Set([1]));
    // clean → not clean. 내린 것이 모두 끝났으니 화면은 "정리했다"고 말한다.
    expect(out.stopped).toBe(false);
    expect(out.leaked).toEqual([]);
    expect(out.cleanedUp).toBe(true);
    expect(out.detail).toMatch(/7002/);
    expect(out.detail).toMatch(/7003/);
    expect(leftoverNotice(out).message).toBe("종료하면서 남아 있던 프로세스를 정리했어요.");
    expect(logs.join("\n")).toMatch(/놓친/);
  });
});

describe("supervisor.stopAll — 진행 중인 배경 기동 (C1)", () => {
  it("does not let a background bring create a process after stopAll returned", async () => {
    // launchPython도 launchDev도 detached다. stopAll이 반환한 **뒤에** 만들어진 자식은
    // Electron이 죽어도 살아남고, 그것을 가리키는 참조는 아무 데도 없다 (P2-C4).
    const live = new Set<number>();
    let launched = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const s = createSupervisor(
      [
        spec("worker", {
          gate: false,
          detectExternal: async () => {
            await held;
            return { kind: "absent" };
          },
          launch: async () => {
            launched += 1;
            live.add(4242);
            return { handle: null, owned: true };
          },
          stop: async () => {
            live.delete(4242);
            return { stopped: true, leaked: [] };
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    const stopping = s.stopAll({ graceMs: 5 });
    release();
    const out = await stopping;
    await new Promise((r) => setTimeout(r, 30));
    // 만들었다가 도로 치우는 것으로는 부족하다 — 종료가 시작된 뒤에는 아예 만들지 않는다.
    expect(launched).toBe(0);
    expect([...live]).toEqual([]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("stops a process the background bring created while stopAll was waiting", async () => {
    // launch()가 반환하고 rt.result에 대입되기까지의 구간. stopping 깃발만으로는 못 막고,
    // stopAll이 pending을 기다려야 그 자식이 역순 루프에 잡힌다 — 그래야 leaked도 정직하다.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const stopped: number[] = [];
    const s = createSupervisor(
      [
        spec("worker", {
          gate: false,
          launch: async () => {
            await held;
            return { handle: null, owned: true };
          },
          stop: async () => {
            stopped.push(4242);
            return { stopped: false, leaked: [4242] };
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopping = s.stopAll({ graceMs: 5 });
    release();
    const out = await stopping;
    expect(stopped).toEqual([4242]);
    expect(out).toEqual({ stopped: false, leaked: [4242] });
  });
});

describe("supervisor health monitoring (C2)", () => {
  it("re-probes readiness after ready and comes back from degraded on its own", async () => {
    // 스펙 §6.6 — API는 부팅 뒤 DB가 끊겨도 죽지 않고 503을 준다. 다시 묻지 않으면 감독자는
    // 영원히 running/ok이고 모든 요청은 실패한다. P2-C11이 판정하는 것이 이 왕복이다.
    let phase: ReadinessResult = { kind: "ready" };
    const probes: number[] = [];
    const s = createSupervisor(
      [
        spec("api", {
          healthIntervalMs: 5,
          readiness: async () => {
            probes.push(1);
            return phase;
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses()[0].health).toBe("ok");

    phase = { kind: "degraded", detail: "DB에 못 붙어요." };
    await vi.waitFor(() => {
      const st = s.statuses()[0];
      expect(st.process).toBe("running");
      expect(st.health).toBe("degraded");
      expect(st.detail).toBe("DB에 못 붙어요.");
    });

    phase = { kind: "ready" };
    await vi.waitFor(() => expect(s.statuses()[0].health).toBe("ok"));

    await s.stopAll({ graceMs: 5 });
    const after = probes.length;
    await new Promise((r) => setTimeout(r, 40));
    // 재프로브 타이머도 timers에 있으므로 stopAll이 껐다.
    expect(probes.length).toBe(after);
  });

  it("records a failing health probe without restarting the service", async () => {
    // 재프로브는 상태만 바꾼다. 여기서 재시작을 걸면 의존이 돌아오지 않는 한 같은 실패를
    // 반복하며 백오프만 태운다 (스펙 §6.8).
    let launches = 0;
    let phase: ReadinessResult = { kind: "ready" };
    const s = createSupervisor(
      [
        spec("worker", {
          healthIntervalMs: 5,
          restart: { maxAttempts: 3, backoffMs: [5] },
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
          readiness: async () => phase,
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    phase = { kind: "failed", detail: "포트가 닫혔어요." };
    await vi.waitFor(() => expect(s.statuses()[0].detail).toBe("포트가 닫혔어요."));
    await new Promise((r) => setTimeout(r, 30));
    expect(launches).toBe(1);
    expect(s.statuses()[0].process).toBe("running");
    expect(s.statuses()[0].restarts).toBe(0);
    await s.stopAll({ graceMs: 5 });
  });
});

describe("supervisor 배경 실패 처리 (I1)", () => {
  it("drops a background readiness poll the moment stopAll begins", async () => {
    // 배경 폴링이 남은 readyTimeoutMs를 다 써 버리면 pending을 기다리는 stopAll이 그만큼
    // 막힌다 — embed의 그 값은 180초다. 그리고 그 폴링은 stopAll이 null로 만든 rt.result를
    // 어댑터에 그대로 넘겨(첫 줄이 result.handle 역참조다) 처리되지 않은 rejection을 만든다.
    let sawNull = false;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: false,
          readiness: async (result) => {
            if ((result as LaunchResult | null) === null) sawNull = true;
            return { kind: "not-ready" };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 5_000, readyIntervalMs: 5 },
    );
    await s.start();
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    await s.stopAll({ graceMs: 5 });
    // 5초 유예에 1초 한도 — 재는 것은 "폴링을 끝까지 기다렸는가"뿐이라 여유가 5배다.
    expect(Date.now() - t0).toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 40));
    expect(sawNull).toBe(false);
  });

  it("reports failed when detectExternal throws instead of pinning the service", async () => {
    // worker의 detectExternal은 Task 12가 주입하는 ps 실행이다. 그것이 던지면 서비스는
    // 화면 문구도 재시작도 없이 기동 전 상태에 영영 고정된다.
    const s = createSupervisor(
      [
        spec("worker", {
          detectExternal: async () => {
            throw new Error("ps를 못 돌렸어요");
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    const st = s.statuses()[0];
    expect(st.process).toBe("failed");
    expect(st.detail).toContain("ps를 못 돌렸어요");
  });

  it("treats a throwing readiness as a failed probe instead of blowing up the start sequence", async () => {
    // postgres의 readiness는 postmaster.pid를 읽는다 — 파서가 던지면 여기로
    // 온다. 잡지 않으면 bringOnce가 통째로 거부해 (1) 실패 정리가 건너뛰어져 rt.result가 남고,
    // 남은 rt.result는 재진입 가드에 걸려 이 서비스의 재시도를 앱이 사는 내내 막으며,
    // (2) 게이트라서 그 거부가 runFrom을 타고 start()까지 올라간다.
    const stop = vi.fn(async () => ({ stopped: true, leaked: [] }));
    const launch = vi.fn(async () => ({ handle: null, owned: true }));
    const later = vi.fn(async () => ({ handle: null, owned: true }));
    let throwing = true;
    const s = createSupervisor(
      [
        spec("postgres", {
          launch,
          stop,
          readiness: async () => {
            if (throwing) throw new TypeError("Cannot read properties of null (reading 'Service')");
            return { kind: "ready" };
          },
        }),
        spec("api", { dependsOn: ["postgres"], launch: later }),
      ],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );

    await expect(s.start()).resolves.toBeUndefined();
    const st = s.statuses().find((x) => x.id === "postgres")!;
    expect(st.process).toBe("failed");
    expect(st.detail).toContain("Cannot read properties of null");
    // 게이트가 막혔으니 뒤는 뜨지 않는다 — failed 판정을 받은 게이트와 똑같이 군다.
    expect(later).not.toHaveBeenCalled();
    // 실패 경로가 돌았다: 우리가 띄운 것을 치웠고,
    expect(stop).toHaveBeenCalled();
    // rt.result를 비워 뒀기에 메뉴의 "다시 시도"가 실제로 다시 띄운다.
    throwing = false;
    await s.retry();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(s.statuses().find((x) => x.id === "postgres")!.process).toBe("running");
  });

  it("turns a throwing gate launch into a failed status — start() resolves, and the background service it already started stays stoppable (F6)", async () => {
    // F6의 전제: start()가 거부할 수 있는 곳은 prepare() 하나다. main.ts의 createSupervisorFor는 start()가
    // 거부하면 **감독자를 버린다**(재시도가 prepare를 영영 건너뛰지 않게) — 그 판단이 안전한 것은 거부가
    // 어떤 launch보다 먼저 났을 때뿐이다. 그런데 게이트 postgres의 launch(postmaster 스폰)가 던질 때
    // bringOnce의 catch가 없으면 그 거부가 runFrom을 타고 start()까지 오르고, 그 사이 배경으로 이미 뜬
    // embed는 버려진 감독자에만 적혀 있어 아무도 내리지 못한다(P2-C4). 최종 리뷰에서 그 catch를 지워도
    // 522개가 초록이었다.
    const embedStop = vi.fn(async () => ({ stopped: true, leaked: [] }));
    const embedLaunch = vi.fn(async () => ({ handle: null, owned: true }));
    const apiLaunch = vi.fn(async () => ({ handle: null, owned: true }));
    const s = createSupervisor(
      [
        spec("embed", { gate: false, launch: embedLaunch, stop: embedStop }),
        spec("postgres", {
          launch: async () => {
            throw new Error("spawn /nowhere/postgres ENOENT");
          },
        }),
        spec("api", { dependsOn: ["postgres"], launch: apiLaunch }),
      ],
      ctx(),
      { readyTimeoutMs: 50, readyIntervalMs: 5 },
    );

    await expect(s.start()).resolves.toBeUndefined();
    const pg = s.statuses().find((x) => x.id === "postgres")!;
    expect(pg.process).toBe("failed");
    expect(pg.detail).toContain("spawn /nowhere/postgres ENOENT");
    expect(apiLaunch).not.toHaveBeenCalled();

    // 감독자가 살아 있으므로 배경 embed는 여전히 이 감독자의 것이다 — 종료가 그것을 내린다.
    await vi.waitFor(() => expect(embedLaunch).toHaveBeenCalledTimes(1));
    await s.stopAll({ graceMs: 5 });
    expect(embedStop).toHaveBeenCalledTimes(1);
  });

  it("turns an exception in a background bring into a failed status", async () => {
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          readiness: async () => {
            throw new Error("프로브가 터졌어요");
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 50, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => {
      const st = s.statuses()[0];
      expect(st.process).toBe("failed");
      expect(st.detail).toContain("프로브가 터졌어요");
    });
  });
});

describe("supervisor 게이트 재시작과 재시도 (I3·I4·I5)", () => {
  it("does not restart a gate service that failed during the initial start", async () => {
    // 재시작이 이 서비스만 되살리면 창은 실패 화면인데 상태 창만 running이 되고, 뒤 서비스는
    // 영원히 안 뜬다. 그 경우의 복구는 메뉴의 "다시 시도" = retry()다 (스펙 §6.8).
    let launches = 0;
    const later = vi.fn(async () => ({ handle: null, owned: true }));
    const s = createSupervisor(
      [
        spec("api", {
          restart: { maxAttempts: 3, backoffMs: [5] },
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
          readiness: async () => ({ kind: "failed", detail: "부팅에 실패했어요." }),
        }),
        spec("worker", { dependsOn: ["api"], launch: later }),
      ],
      ctx(),
      { readyTimeoutMs: 50, readyIntervalMs: 5 },
    );
    await s.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(launches).toBe(1);
    expect(later).not.toHaveBeenCalled();
    const st = s.statuses().find((x) => x.id === "api")!;
    expect(st.process).toBe("failed");
    expect(st.restarts).toBe(0);
  });

  it("gives the restart budget back after the service stays ready", async () => {
    // 안 돌려주면 maxAttempts가 앱 실행 전체의 누적 상한이 되어, 한 번씩 복구된 서비스가
    // 나중에는 영영 재시작되지 않는다 (스펙 §6.8 "retryCount는 ready 도달 시 0으로").
    let launches = 0;
    let listener: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("worker", {
          restart: { maxAttempts: 1, backoffMs: [5] },
          launch: async () => {
            launches += 1;
            return {
              handle: fakeHandle((l) => {
                listener = l;
              }),
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5, stableResetMs: 100 },
    );
    await s.start();
    listener!(1);
    // onExit는 동기로 불리므로 예산 1을 쓴 것이 이 줄에서 이미 보인다.
    expect(s.statuses()[0].restarts).toBe(1);
    await vi.waitFor(() => expect(launches).toBe(2));
    // 안정 창을 넘기면 예산이 돌아온다.
    await vi.waitFor(() => expect(s.statuses()[0].restarts).toBe(0));
    listener!(1);
    await vi.waitFor(() => expect(launches).toBe(3));
    await s.stopAll({ graceMs: 5 });
  });

  it("retry resumes the sequence without re-running prepare or relaunching a running service", async () => {
    // start()를 다시 부르는 것으로 때우면 prepare()가 전부 다시 돌아 살아 있는 embed 밑에서
    // 포트가 바뀌고, 이미 running인 api 위에 두 번째 인스턴스가 떠서 첫 핸들을 놓친다.
    let prepares = 0;
    let apiLaunches = 0;
    let workerLaunches = 0;
    let apiReady = false;
    const s = createSupervisor(
      [
        spec("api", {
          restart: { maxAttempts: 1, backoffMs: [5] },
          prepare: async () => {
            prepares += 1;
            return { EMBED_SERVICE_PORT: String(8100 + prepares) };
          },
          launch: async () => {
            apiLaunches += 1;
            return { handle: null, owned: true };
          },
          readiness: async () => (apiReady ? { kind: "ready" } : { kind: "failed", detail: "DB가 없어요." }),
        }),
        spec("worker", {
          dependsOn: ["api"],
          launch: async () => {
            workerLaunches += 1;
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    expect(apiLaunches).toBe(1);
    expect(workerLaunches).toBe(0);

    apiReady = true;
    await s.retry();
    expect(prepares).toBe(1);
    expect(apiLaunches).toBe(2);
    expect(workerLaunches).toBe(1);

    // 두 번째 재시도는 둘 다 running이므로 아무것도 하지 않는다.
    await s.retry();
    expect(apiLaunches).toBe(2);
    expect(workerLaunches).toBe(1);
  });
});

describe("supervisor 단일 비행과 종료의 시야 (N1·N2)", () => {
  it("stops a process a gate bring created while stopAll was waiting", async () => {
    // 게이트 bring은 runFrom이 인라인으로 await한다. 그 프라미스가 pending에 없으면 stopAll은
    // bring 진입부터 rt.result 대입까지 — API는 그 구간이 부팅 전체라 수 초다 — 를 통째로 못
    // 보고 지나간다. 사용자 경로는 스플래시에서 API가 아직 뜨는 중에 ⌘Q다. 그렇게 태어난
    // 자식은 detached라 Electron이 죽어도 살아 포트 3000을 쥔다 (P2-C4).
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const live = new Set<number>();
    const s = createSupervisor(
      [
        spec("api", {
          gate: true,
          launch: async () => {
            await held;
            live.add(3000);
            return { handle: null, owned: true };
          },
          stop: async () => {
            live.delete(3000);
            return { stopped: false, leaked: [3000] };
          },
        }),
      ],
      ctx(),
      {},
    );
    // start()를 await하지 않는다 — 부팅이 끝나기 전에 종료가 오는 것이 이 결함의 전제다.
    const started = s.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopping = s.stopAll({ graceMs: 5 });
    // 게이트 구간을 기다리지 않는 stopAll은 이 20ms 안에 이미 반환해 버린다.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const out = await stopping;
    await started;
    // 자식은 stopAll이 기다리는 동안 태어났다. 그것을 내리고, leaked에 정직하게 싣는다.
    expect([...live]).toEqual([]);
    expect(out).toEqual({ stopped: false, leaked: [3000] });
  });

  it("launches once when a retry races the bring that is already starting", async () => {
    // 재진입 가드(rt.result !== null)는 launch가 반환한 **뒤에야** 문다. detectExternal 안에
    // 멈춘 사이에 메뉴의 "다시 시도"가 눌리면 두 bring이 나란히 그 가드를 지나 프로세스가 두 벌
    // 뜨고, 먼저 뜬 쪽의 유일한 참조인 rt.result가 덮어써져 stopAll이 영원히 못 찾는다.
    // 메뉴는 app.whenReady()에서 기동 시퀀스가 끝나기 전에 이미 설치된다 (Task 13).
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const live = new Set<number>();
    let launches = 0;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: false,
          detectExternal: async () => {
            await held;
            return { kind: "absent" };
          },
          launch: async () => {
            launches += 1;
            const pid = 7000 + launches;
            live.add(pid);
            return { handle: null, owned: true, origin: String(pid) };
          },
          stop: async (result) => {
            live.delete(Number(result.origin));
            return { stopped: true, leaked: [] };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await s.retry();
    release();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    await new Promise((r) => setTimeout(r, 20));
    expect(launches).toBe(1);
    // 두 벌 떴다면 stopAll이 쥔 참조는 하나뿐이라 나머지 한 벌이 여기 남는다.
    await s.stopAll({ graceMs: 5 });
    expect([...live]).toEqual([]);
  });
});

describe("createSupervisor — 죽은 자식의 원인 (스펙 §8, Task 14)", () => {
  // Phase 1의 failureBlock은 api 어댑터의 readiness에서만 불렸는데, awaitReady가 readiness보다
  // **먼저** 죽음을 보고 "프로세스가 종료됐어요 (코드 1)."로 끝냈다. packaged에서 zod 검증 실패로
  // exit(1)한 API의 원인은 그래서 한 번도 화면에 오르지 못했다.
  const ZOD_STDERR = [
    "[Nest] 1  - 09/13/2026   LOG [NestFactory] Starting Nest application...",
    "\x1b[31m[Nest] 1  - ERROR [Bootstrap] startup failed: [",
    "  {",
    '    "received": "not-in-the-catalog",',
    '    "path": ["SUMMARY_LLM_MODEL"]',
    "  }",
    "]\x1b[39m",
  ].join("\n");

  const deadHandle = (stderr: string, code = 1) =>
    ({
      pid: 1,
      alive: () => false,
      stderrTail: () => stderr,
      exitCode: () => code,
      onExit: () => undefined,
      stop: async () => undefined,
    }) as never;

  it("shows the exit code and the whole startup-failed block when a child dies before ready", async () => {
    const s = createSupervisor(
      [spec("api", { launch: async () => ({ handle: deadHandle(ZOD_STDERR), owned: true }) })],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    const st = s.statuses()[0];
    expect(st.process).toBe("failed");
    expect(st.detail).toBe(
      [
        "프로세스가 종료됐어요 (코드 1).",
        "[Nest] 1  - ERROR [Bootstrap] startup failed: [",
        "  {",
        '    "received": "not-in-the-catalog",',
        '    "path": ["SUMMARY_LLM_MODEL"]',
        "  }",
        "]",
      ].join("\n"),
    );
  });

  it("shows the last stderr lines of a Python child that dies without a startup-failed line", async () => {
    const trace = ["Traceback (most recent call last):", '  File "x.py", line 1', "ModuleNotFoundError: No module named 'mlx'"];
    const s = createSupervisor(
      [spec("worker", { launch: async () => ({ handle: deadHandle(trace.join("\n"), 2), owned: true }) })],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses()[0].detail).toBe(["프로세스가 종료됐어요 (코드 2).", ...trace].join("\n"));
  });

  it("shows the stderr block when a child dies after ready, too", async () => {
    let listener: ((code: number) => void) | null = null;
    let stderr = "";
    const s = createSupervisor(
      [
        spec("embed", {
          launch: async () => ({
            handle: {
              pid: 1,
              alive: () => true,
              stderrTail: () => stderr,
              exitCode: () => null,
              onExit: (l: (c: number) => void) => {
                listener = l;
              },
              stop: async () => undefined,
            } as never,
            owned: true,
          }),
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses()[0].process).toBe("running");
    stderr = "RuntimeError: Metal device lost";
    listener!(134);
    expect(s.statuses()[0].detail).toBe("프로세스가 종료됐어요 (코드 134).\nRuntimeError: Metal device lost");
  });

  it("bounds what it puts on screen — never the raw 8 KB tail", async () => {
    const tail = `${"진행 ".repeat(2_700)}\nRuntimeError: boom`;
    expect(tail.length).toBeGreaterThan(7_000);
    const s = createSupervisor(
      [spec("worker", { launch: async () => ({ handle: deadHandle(tail, 1), owned: true }) })],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    const detail = s.statuses()[0].detail ?? "";
    expect(detail.length).toBeLessThanOrEqual("프로세스가 종료됐어요 (코드 1).\n".length + 3_001);
    expect(detail.endsWith("RuntimeError: boom")).toBe(true);
  });

  it("fails a live API whose stderr says startup failed without waiting out the ready timeout (dev: nest --watch)", async () => {
    // 감독자 수준에서 본다: judgeAfterProbe가 실패를 돌려주면 awaitReady는 유예를 기다리지 않고
    // 곧장 failed로 끝낸다. 판정이 not-ready로 돌아가면 이 테스트는 30초 유예 대신 1초 안에 실패한다.
    const handle = {
      pid: 1,
      alive: () => true,
      stderrTail: () => 'ERROR [Bootstrap] startup failed: [\n  { "path": ["SUMMARY_LLM_MODEL"] }\n]',
      stdoutTail: () => "",
      exitCode: () => null,
      onExit: () => undefined,
      stop: async () => undefined,
    };
    const s = createSupervisor(
      [
        spec("api", {
          launch: async () => ({ handle, owned: true }),
          readiness: (result) =>
            judgeAfterProbe(result.handle!, "no-response", 3000, {
              verifyOwnListener: async () => true,
              isPortOccupied: async () => false,
              onPendingMigrations: () => undefined,
              onMigrationCheckSkipped: () => undefined,
            }),
        }),
      ],
      ctx(),
      { readyTimeoutMs: 30_000, readyIntervalMs: 5 },
    );
    try {
      const started = Date.now();
      // await하지 않는다 — 게이트라 start()는 준비 판정이 끝날 때까지 돌아오지 않고, 되돌린 변이에서는
      // 그것이 30초다.
      void s.start();
      await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"), { timeout: 1_000 });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(s.statuses()[0].detail).toContain('"path": ["SUMMARY_LLM_MODEL"]');
    } finally {
      await s.stopAll({ graceMs: 5 });
    }
  });

  it("keeps the bare exit line when the child left nothing on stderr", async () => {
    const s = createSupervisor(
      [spec("api", { launch: async () => ({ handle: deadHandle("   \n"), owned: true }) })],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses()[0].detail).toBe("프로세스가 종료됐어요 (코드 1).");
  });
});

describe("createSupervisor — 재시도와 stand-down (Task 14 Q1)", () => {
  it("retry re-detects a service the app stood down for, and launches its own once the external one is gone", async () => {
    // 상태 창의 안내가 "터미널의 worker를 끄고 다시 시도하거나…"다. 재시도가 running인 stand-down
    // worker를 건너뛰면 그 안내는 사용자가 따라 해도 아무 일도 일어나지 않는 거짓이 된다.
    let external = true;
    let detects = 0;
    let launches = 0;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: false,
          detectExternal: async () => {
            detects += 1;
            return external ? { kind: "stand-down", detail: "외부 worker가 실행 중이에요 (pid 4101)." } : { kind: "absent" };
          },
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0]).toMatchObject({ process: "running", owned: false }));
    expect(launches).toBe(0);

    external = false;
    await s.retry();
    await vi.waitFor(() => expect(s.statuses()[0]).toMatchObject({ process: "running", owned: true }));
    expect(detects).toBe(2);
    expect(launches).toBe(1);
    // ready가 stand-down의 경고를 지운다.
    expect(s.statuses()[0].detail).toBeUndefined();
    await s.stopAll({ graceMs: 5 });
  });

  it("retry just stands down again while the external worker is still running", async () => {
    let launches = 0;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: false,
          detectExternal: async () => ({ kind: "stand-down", detail: "외부 worker" }),
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await s.retry();
    await new Promise((r) => setTimeout(r, 20));
    expect(launches).toBe(0);
    expect(s.statuses()[0]).toMatchObject({ process: "running", owned: false, detail: "외부 worker" });
  });

  it("retry does not touch an adopted service or a running one the app launched — no second instance beside them", async () => {
    // 넓힌 필터 때문에 이미 가진 인스턴스 옆에 두 번째가 뜨지 않는지 **결과로** 고정한다. 채택은
    // {handle: null, owned: false}를, 앱이 띄운 것은 자기 결과를 쥐므로 필터에 걸리지 않는다.
    // 막는 층은 둘이다: 이 필터와 bringOnce 첫머리의 재진입 가드(`rt.result !== null`, detectExternal
    // **앞**). 둘은 서로를 덮어서 하나만 무너뜨리는 변이는 관찰되지 않는다 — 필터를 전부로 넓혀도,
    // 가드만 지워도 초록이다(실측). 둘 다 무너뜨리면 여기서 detectExternal·launch가 다시 돈다.
    const detects = { postgres: 0, api: 0 };
    const launches = { postgres: 0, api: 0 };
    const s = createSupervisor(
      [
        spec("postgres", {
          detectExternal: async () => {
            detects.postgres += 1;
            return { kind: "adopt", detail: "이미 실행 중인 컨테이너" };
          },
          launch: async () => {
            launches.postgres += 1;
            return { handle: null, owned: true };
          },
        }),
        spec("api", {
          dependsOn: ["postgres"],
          detectExternal: async () => {
            detects.api += 1;
            return { kind: "absent" };
          },
          launch: async () => {
            launches.api += 1;
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses().map((x) => [x.id, x.process, x.owned])).toEqual([
      ["postgres", "running", false],
      ["api", "running", true],
    ]);
    await s.retry();
    await new Promise((r) => setTimeout(r, 20));
    expect(detects).toEqual({ postgres: 1, api: 1 });
    expect(launches).toEqual({ postgres: 0, api: 1 });
  });
});

describe("supervisor — recovery class and launch abort (Phase 3)", () => {
  it("copies a manual class from a launch failure onto the status", async () => {
    const s = createSupervisor(
      [spec("postgres", { launch: async () => { throw new ServiceFailure("짝이 맞지 않아요", "manual"); } })],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0]).toMatchObject({ process: "failed", recovery: "manual", detail: "짝이 맞지 않아요" });
  });

  it("copies a manual class from a failed readiness onto the status", async () => {
    const s = createSupervisor(
      [spec("api", { readiness: async () => ({ kind: "failed", detail: "마이그레이션 실패", recovery: "manual" }) })],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0]).toMatchObject({ process: "failed", recovery: "manual" });
  });

  it("leaves the class empty for an untagged failure — Phase 2 adapters keep auto", async () => {
    const s = createSupervisor(
      [spec("api", { launch: async () => { throw new Error("spawn ENOENT"); } })],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0].recovery).toBeUndefined();
  });

  it("clears the class when the service is tried again", async () => {
    let first = true;
    const s = createSupervisor(
      [
        spec("postgres", {
          launch: async () => {
            if (first) {
              first = false;
              throw new ServiceFailure("거부", "manual");
            }
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0].recovery).toBe("manual");
    await s.retry();
    expect(s.statuses()[0]).toMatchObject({ process: "running", recovery: undefined });
  });

  it("does not schedule a restart for a manual readiness failure of a background service", async () => {
    // 재시작해도 같은 판정이 나오고(짝이 맞지 않는다), 반복이 도구를 또 부른다.
    const log: string[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          readiness: async () => ({ kind: "failed", detail: "거부", recovery: "manual" }),
          restart: { maxAttempts: 3, backoffMs: [1, 1, 1] },
        }),
      ],
      ctx(),
      { log: (l) => void log.push(l) },
    );
    await s.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.statuses()[0]).toMatchObject({ process: "failed", restarts: 0 });
    expect(log.some((l) => l.includes("재시작"))).toBe(false);
  });

  it("aborts ctx.signal at the start of stopAll so a hung launch() cannot hold ⌘Q", async () => {
    // 클로저 안에서 대입하는 let은 TS가 null로 좁혀 버린다. 상자에 담는다.
    const box: { signal?: AbortSignal } = {};
    const s = createSupervisor(
      [
        spec("postgres", {
          launch: (c) =>
            new Promise<LaunchResult>((_, reject) => {
              box.signal = c.signal;
              c.signal.addEventListener("abort", () => reject(new ServiceFailure("중단됨", "manual")));
            }),
        }),
      ],
      ctx(),
      {},
    );
    const starting = s.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopped = await Promise.race([
      s.stopAll({ graceMs: 10 }).then(() => "stopped"),
      new Promise((r) => setTimeout(() => r("hung"), 1_000)),
    ]);
    expect(stopped).toBe("stopped");
    expect(box.signal?.aborted).toBe(true);
    await starting;
  });
});

/**
 * 스펙 §6.9 — "진행이 갱신되고 있으면 유예를 소모하지 않는다". 감독자 쪽 적용 지점은 embed의
 * `readyTimeoutMs`(180초)이고, 그 제한은 bge-m3 첫 다운로드보다 짧다.
 */
describe("supervisor — 다운로드 중에는 준비 유예를 멈춘다 (Task 10)", () => {
  /** worker가 쓰는 고정 정밀도 UTC 문자열 (db/core.py의 `_ISO_FORMAT`). */
  const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "000Z");

  /** `model_readiness` 한 행. 리더 dep이 돌려주는 raw jsonb 모양 그대로다. */
  function readinessRow(writer: string, updatedAt: number, state = "downloading") {
    return {
      updated_at: iso(updatedAt),
      entries: {
        "BAAI/bge-m3": {
          state,
          bytes_done: 1,
          bytes_total: 0,
          writer,
          attempt: 1,
          started_at: iso(updatedAt),
          updated_at: iso(updatedAt),
          error: null,
          error_kind: null,
        },
      },
    };
  }

  it("does not let the grace expire while this service's model is downloading", async () => {
    let ready = false;
    const s = createSupervisor(
      [spec("embed", { gate: false, readiness: async () => (ready ? { kind: "ready" } : { kind: "not-ready" }) })],
      ctx(),
      {
        readyTimeoutMs: 40,
        readyIntervalMs: 5,
        readinessPollMs: 0,
        readModelReadiness: async () => readinessRow("embed", Date.now()),
      },
    );
    await s.start();
    // 유예(40ms)의 다섯 배를 기다려도 실패하지 않는다 — 진행이 갱신되고 있다.
    await new Promise((r) => setTimeout(r, 200));
    expect(s.statuses()[0].process).toBe("starting");
    ready = true;
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    await s.stopAll({ graceMs: 5 });
  });

  it("lets the grace expire once the progress has stood still past the stall limit", async () => {
    const s = createSupervisor(
      [spec("embed", { gate: false, readiness: async () => ({ kind: "not-ready" }) })],
      ctx(),
      {
        readyTimeoutMs: 40,
        readyIntervalMs: 5,
        readinessPollMs: 0,
        readModelReadiness: async () => readinessRow("embed", Date.now() - STALL_MS - 1_000),
      },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"));
    await s.stopAll({ graceMs: 5 });
  });

  it("does not stop this service's clock for another writer's download", async () => {
    // embed가 죽어 가는 동안 worker가 whisper를 받고 있으면 embed의 유예가 영영 안 끝난다.
    const s = createSupervisor(
      [spec("embed", { gate: false, readiness: async () => ({ kind: "not-ready" }) })],
      ctx(),
      {
        readyTimeoutMs: 40,
        readyIntervalMs: 5,
        readinessPollMs: 0,
        readModelReadiness: async () => readinessRow("desktop-other", Date.now()),
      },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"));
    await s.stopAll({ graceMs: 5 });
  });

  it("knows the worker's own download by this run's WORKER_ID", async () => {
    const c = ctx();
    c.env.WORKER_ID = "desktop-run-77";
    let ready = false;
    const s = createSupervisor(
      [spec("worker", { gate: false, readiness: async () => (ready ? { kind: "ready" } : { kind: "not-ready" }) })],
      c,
      {
        readyTimeoutMs: 40,
        readyIntervalMs: 5,
        readinessPollMs: 0,
        readModelReadiness: async () => readinessRow("desktop-run-77", Date.now()),
      },
    );
    await s.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.statuses()[0].process).toBe("starting");
    ready = true;
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    await s.stopAll({ graceMs: 5 });
  });

  it("counts cumulatively — a finished download does not leave zero grace behind", async () => {
    // 고정 deadline이면 다운로드가 끝난 순간 남은 유예가 0이라 곧바로 실패한다 (스펙 §6.9).
    let downloading = true;
    const s = createSupervisor(
      [spec("embed", { gate: false, readiness: async () => ({ kind: "not-ready" }) })],
      ctx(),
      {
        readyTimeoutMs: 80,
        readyIntervalMs: 5,
        readinessPollMs: 0,
        readModelReadiness: async () =>
          downloading ? readinessRow("embed", Date.now()) : readinessRow("embed", Date.now(), "ready"),
      },
    );
    await s.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.statuses()[0].process).toBe("starting");
    const flipped = Date.now();
    downloading = false;
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"), { timeout: 2_000 });
    // 다운로드가 끝난 **뒤에** 유예를 쓰기 시작한다. 즉시 실패면 누적이 아니라 고정 deadline이다.
    expect(Date.now() - flipped).toBeGreaterThanOrEqual(60);
    await s.stopAll({ graceMs: 5 });
  });

  it("burns the grace as before when no reader is wired (external DB mode)", async () => {
    const s = createSupervisor(
      [spec("embed", { gate: false, readiness: async () => ({ kind: "not-ready" }) })],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"));
    await s.stopAll({ graceMs: 5 });
  });

  it("treats a reader failure as 'nothing is downloading' instead of throwing", async () => {
    const log: string[] = [];
    const s = createSupervisor(
      [spec("embed", { gate: false, readiness: async () => ({ kind: "not-ready" }) })],
      ctx(),
      {
        readyTimeoutMs: 30,
        readyIntervalMs: 5,
        readinessPollMs: 0,
        readModelReadiness: async () => {
          throw new Error("psql이 죽었어요");
        },
        log: (l) => void log.push(l),
      },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"));
    expect(log.some((l) => l.includes("psql이 죽었어요"))).toBe(true);
    await s.stopAll({ graceMs: 5 });
  });
});

/** 스펙 §6.10 2층 — 살아 있는 서비스도 내리는 재시작. `retry()`와 별도 경로다. */
describe("supervisor.restartService (Task 10)", () => {
  it("is a method on the supervisor object", () => {
    const s = createSupervisor([spec("embed")], ctx(), {});
    expect(typeof s.restartService).toBe("function");
  });

  it("takes down a running service the app owns and brings it back", async () => {
    let launches = 0;
    const stops: number[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
          stop: async () => {
            stops.push(launches);
            return { stopped: true, leaked: [] };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    expect(launches).toBe(1);

    await s.restartService("embed");

    expect(stops).toEqual([1]);
    expect(launches).toBe(2);
    expect(s.statuses()[0]).toMatchObject({ process: "running", owned: true });
    await s.stopAll({ graceMs: 5 });
  });

  it("refuses an adopted external instance — the app cannot take down what it does not own", async () => {
    const log: string[] = [];
    let launches = 0;
    const stops: string[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          detectExternal: async () => ({ kind: "adopt", detail: "이미 실행 중인 embed" }),
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
          stop: async () => {
            stops.push("stopped");
            return { stopped: true, leaked: [] };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5, log: (l) => void log.push(l) },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0]).toMatchObject({ process: "running", owned: false }));

    await s.restartService("embed");

    expect(launches).toBe(0);
    expect(stops).toEqual([]);
    expect(s.statuses()[0]).toMatchObject({ process: "running", owned: false });
    expect(log.some((l) => l.includes("소유"))).toBe(true);
    await s.stopAll({ graceMs: 5 });
  });

  it("refuses a stand-down service — the external worker is not ours to restart", async () => {
    // 재탐지조차 하지 않는다. 그 길은 retry()의 것이고(외부 worker를 끄고 "다시 시도"),
    // 이 버튼은 **앱이 쥔** 프로세스를 갈아 끼우는 길이다 (스펙 §6.10 2층).
    let launches = 0;
    let detects = 0;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: false,
          detectExternal: async () => {
            detects += 1;
            return { kind: "stand-down", detail: "외부 worker" };
          },
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0]).toMatchObject({ process: "running", owned: false }));
    expect(detects).toBe(1);

    await s.restartService("worker");

    expect(launches).toBe(0);
    expect(detects).toBe(1);
    expect(s.statuses()[0]).toMatchObject({ process: "running", owned: false, detail: "외부 worker" });
    await s.stopAll({ graceMs: 5 });
  });

  it("ignores the late death of the instance it just took down", async () => {
    // 신호와 종료 이벤트 사이에는 await가 둘 있다 — 옛 자식의 onExit은 **새 자식이 뜬 뒤에**
    // 도착할 수 있다. 그것을 그대로 처리하면 새 인스턴스가 failed로 적히고 그 유일한 참조가
    // 지워져(rt.result = null) 아무도 못 찾는 자식이 남는다.
    let launches = 0;
    const stops: string[] = [];
    const exits: ((code: number) => void)[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => {
            launches += 1;
            return { handle: fakeHandle((l) => exits.push(l)), owned: true };
          },
          stop: async () => {
            stops.push(`stop${launches}`);
            // 실제 핸들처럼 **나중에** 알린다.
            setTimeout(() => exits[0]?.(0), 10);
            return { stopped: true, leaked: [] };
          },
          restart: { maxAttempts: 3, backoffMs: [1, 1, 1] },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));

    await s.restartService("embed");
    await new Promise((r) => setTimeout(r, 40));

    expect(launches).toBe(2);
    expect(s.statuses()[0]).toMatchObject({ process: "running", restarts: 0 });
    // 새 인스턴스를 앱이 여전히 쥐고 있다 — 종료가 그것을 내릴 수 있어야 한다.
    await s.stopAll({ graceMs: 5 });
    expect(stops).toEqual(["stop1", "stop2"]);
  });

  it("brings up a service that is not running at all (failed → running)", async () => {
    let fail = true;
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => {
            if (fail) throw new Error("포트가 막혔어요");
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 50, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"));

    fail = false;
    await s.restartService("embed");

    expect(s.statuses()[0]).toMatchObject({ process: "running", owned: true });
    await s.stopAll({ graceMs: 5 });
  });

  it("does nothing once the app is shutting down", async () => {
    let launches = 0;
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 50, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    await s.stopAll({ graceMs: 5 });

    await s.restartService("embed");
    expect(launches).toBe(1);
  });
});

/**
 * 리뷰 1회차 Important-1 — 내려가지 않은 서비스를 다시 띄우면 두 가지가 깨진다.
 * worker는 영구 stand-down(버튼이 스스로 비활성)이 되고, embed는 포트를 쥔 옛 자식이 참조를 잃는다.
 */
describe("supervisor.restartService — 내려가지 않으면 다시 띄우지 않는다 (fix 1)", () => {
  /** worker 어댑터의 실제 모양: 유예 안에 안 끝나고 물어볼 사람이 없으면 unattended. */
  function stubbornWorker(counters: { launches: number; brings: number }): Partial<ServiceSpec> {
    return {
      gate: false,
      detectExternal: async () => {
        counters.brings += 1;
        return { kind: "absent" as const };
      },
      launch: async () => {
        counters.launches += 1;
        return { handle: null, owned: true };
      },
      stop: async () => ({ stopped: false, leaked: [4242], detail: "worker가 아직 일을 끝내지 않았어요" }),
    };
  }

  it("keeps the handle, refuses, and never re-detects when the worker did not go down", async () => {
    const counters = { launches: 0, brings: 0 };
    const log: string[] = [];
    const s = createSupervisor([spec("worker", stubbornWorker(counters))], ctx(), {
      readyTimeoutMs: 100,
      readyIntervalMs: 5,
      log: (l) => void log.push(l),
    });
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    expect(counters).toEqual({ launches: 1, brings: 1 });

    await s.restartService("worker");

    // 다시 띄우지 않았다 — detectExternal조차 다시 돌지 않는다(그 길에서 stand-down이 나온다).
    expect(counters).toEqual({ launches: 1, brings: 1 });
    // 앱이 여전히 쥐고 있다. ownPid()가 이것을 읽어 "우리 것"을 외부 목록에서 뺀다.
    expect(s.runtimeOf("worker")?.result).not.toBeNull();
    const st = s.statuses()[0];
    expect(st).toMatchObject({ process: "running", owned: true });
    expect(st.detail).toContain("아직 일을 끝내지 않았어요");
    expect(st.detail).toContain("4242");
    expect(log.some((l) => l.includes("다시 띄우지 않는다"))).toBe(true);
    // 버튼은 계속 켜져 있다 — 사람이 잠시 뒤 다시 누를 수 있다.
    expect(restartRefused(st)).toBe(false);
    await s.stopAll({ graceMs: 5 });
  });

  it("stops the still-running service on quit — the refusal did not lose the reference", async () => {
    const counters = { launches: 0, brings: 0 };
    const stops: string[] = [];
    const s = createSupervisor(
      [
        spec("worker", {
          ...stubbornWorker(counters),
          stop: async () => {
            stops.push("stop");
            return { stopped: false, leaked: [4242], detail: "아직 일하는 중" };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    await s.restartService("worker");

    const out = await s.stopAll({ graceMs: 5 });
    expect(stops).toEqual(["stop", "stop"]); // 종료도 같은 결과를 본다
    expect(out.leaked).toEqual([4242]);
    expect(out.stopped).toBe(false);
  });

  it("refuses when an embed that is stuck mid-download outlives the grace", async () => {
    let launches = 0;
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
          // python-launcher의 handle.stop은 SIGTERM 뒤 폴링만 한다 — 안 죽으면 그대로 돌아온다.
          stop: async () => ({ stopped: false, leaked: [777] }),
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));

    await s.restartService("embed");

    expect(launches).toBe(1); // 포트를 쥔 옛 자식 옆에 두 번째를 띄우지 않는다
    expect(s.runtimeOf("embed")?.result).not.toBeNull();
    await s.stopAll({ graceMs: 5 });
  });

  it("treats a throwing stop the same way — keeps the reference, does not bring", async () => {
    let launches = 0;
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
          stop: async () => {
            throw new Error("kill: EPERM");
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));

    await s.restartService("embed");

    expect(launches).toBe(1);
    expect(s.runtimeOf("embed")?.result).not.toBeNull();
    expect(s.statuses()[0].detail).toContain("다시 띄우지 않았어요");
  });

  it("keeps watching the service it failed to take down", async () => {
    // 감시 타이머를 껐다가 되돌리지 않으면 살아 있는 서비스가 그 뒤로 관측되지 않는다.
    let probes = 0;
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          healthIntervalMs: 5,
          readiness: async () => {
            probes += 1;
            return { kind: "ready" };
          },
          stop: async () => ({ stopped: false, leaked: [777] }),
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    await s.restartService("embed");
    const after = probes;

    await vi.waitFor(() => expect(probes).toBeGreaterThan(after));
    await s.stopAll({ graceMs: 5 });
  });
});

describe("restartRefused — 버튼과 감독자가 같은 판정을 쓴다 (fix 3)", () => {
  it("refuses an adopted service that has not reached ready yet", () => {
    // 채택은 detectExternal 직후에 정해지고 ready까지는 starting이다. running만 보면 그 구간에
    // 버튼이 켜지고, 눌러도 감독자가 거부한다.
    expect(restartRefused({ id: "embed", process: "starting", health: "unknown", owned: false, restarts: 0 })).toBe(true);
    expect(restartRefused({ id: "embed", process: "running", health: "ok", owned: false, restarts: 0 })).toBe(true);
  });

  it("allows what the app owns and what is not up at all", () => {
    expect(restartRefused({ id: "embed", process: "running", health: "ok", owned: true, restarts: 0 })).toBe(false);
    expect(restartRefused({ id: "embed", process: "failed", health: "unknown", owned: false, restarts: 0 })).toBe(false);
    expect(restartRefused({ id: "embed", process: "stopped", health: "unknown", owned: false, restarts: 0 })).toBe(false);
  });

  it("agrees with the supervisor while an adopted service is still starting", async () => {
    // 채택한 embed의 readiness를 붙잡아 starting에 머무르게 한 뒤, 그 상태의 statuses()와
    // 실제 restartService의 거부가 같은 답을 내는지 본다.
    let ready = false;
    let launches = 0;
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          detectExternal: async () => ({ kind: "adopt", detail: "이미 실행 중인 embed" }),
          launch: async () => {
            launches += 1;
            return { handle: null, owned: true };
          },
          readiness: async () => (ready ? { kind: "ready" } : { kind: "not-ready" }),
        }),
      ],
      ctx(),
      { readyTimeoutMs: 5_000, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("starting"));
    expect(restartRefused(s.statuses()[0])).toBe(true);

    await s.restartService("embed");
    expect(launches).toBe(0);

    ready = true;
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    await s.stopAll({ graceMs: 5 });
  });
});

describe("supervisor.restartService — 예약된 백오프와 종료 가시성 (fix 4·5)", () => {
  it("disarms a pending backoff restart so it cannot log a phantom attempt", async () => {
    const log: string[] = [];
    let launches = 0;
    const box: { exit?: (code: number) => void } = {};
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => {
            launches += 1;
            return { handle: fakeHandle((l) => (box.exit = l)), owned: true };
          },
          restart: { maxAttempts: 3, backoffMs: [30, 30, 30] },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5, log: (l) => void log.push(l) },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    // 자식이 죽어 백오프가 예약된다.
    box.exit?.(1);
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("failed"));
    expect(s.runtimeOf("embed")?.restartTimer).not.toBeNull();

    await s.restartService("embed");
    expect(s.runtimeOf("embed")?.restartTimer).toBeNull();
    const attempts = log.filter((l) => l.includes("회차")).length;
    await new Promise((r) => setTimeout(r, 60));

    expect(launches).toBe(2);
    expect(log.filter((l) => l.includes("회차")).length).toBe(attempts);
    await s.stopAll({ graceMs: 5 });
  });

  it("is visible to stopAll while it is stopping the old child", async () => {
    // 등록이 없으면 이 창의 ⌘Q가 rt.result가 null인 서비스를 건너뛰고 'stopped: true'로 적는다.
    // 클로저 안에서 대입하는 let은 TS가 null로 좁혀 버린다 — 상자에 담는다.
    const gate: { release?: () => void } = {};
    const stops: string[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          launch: async () => ({ handle: null, owned: true }),
          stop: async () => {
            stops.push("stop");
            // 첫 번째(재시작이 부른 것)만 붙잡는다. 종료가 부르는 두 번째까지 막으면 테스트가
            // 스스로 교착한다 — 종료는 그 정지를 기다리는 쪽이다.
            if (stops.length === 1) await new Promise<void>((r) => (gate.release = r));
            return { stopped: false, leaked: [99] };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));

    const restarting = s.restartService("embed");
    await vi.waitFor(() => expect(stops).toEqual(["stop"]));
    const quitting = s.stopAll({ graceMs: 5 });
    await new Promise((r) => setTimeout(r, 10));
    gate.release?.();

    const out = await quitting;
    await restarting;
    // 종료가 그 정지를 기다렸고, 남은 pid를 정직하게 싣는다.
    expect(out.stopped).toBe(false);
    expect(out.leaked).toEqual([99]);
  });
});

/**
 * 리뷰 2회차 (R-10b) — 1회차가 **닿을 수 있게 만든** 파괴적 경로.
 *
 * worker의 supervisor는 신호를 자기 수명 전체에 걸쳐 누적해 센다
 * (`be/worker/damwha_worker/__main__.py`의 `child_holder["count"]`): 첫 신호는 `proc.terminate()`로
 * `--once` 자식이 안전한 지점에서 job을 큐로 돌려놓게 하지만, 두 번째부터는 `proc.kill()` +
 * `os._exit(1)`이라 처리 중인 job이 requeue 없이 버려진다 (P2-C5).
 */
describe("supervisor.restartService — 정리 중에는 두 번째 신호를 보내지 않는다 (fix 2-1)", () => {
  /** 신호를 받아도 유예 안에 안 끝나는 자식. stop 호출을 신호 발송으로 센다. */
  function stubbornSpec(signals: string[], over: Partial<ServiceSpec> = {}): ServiceSpec {
    const exits: ((code: number) => void)[] = [];
    const s = spec("worker", {
      gate: false,
      launch: async () => ({ handle: fakeHandle((l) => exits.push(l)), owned: true }),
      stop: async () => {
        signals.push("SIGTERM");
        return { stopped: false, leaked: [4242], detail: "아직 일하는 중" };
      },
      restart: { maxAttempts: 3, backoffMs: [5, 5, 5] },
      ...over,
    });
    (s as ServiceSpec & { exits: typeof exits }).exits = exits;
    return s;
  }

  it("sends no second signal when the button is pressed again while the worker winds down", async () => {
    const signals: string[] = [];
    const log: string[] = [];
    const s = createSupervisor([stubbornSpec(signals)], ctx(), {
      readyTimeoutMs: 100,
      readyIntervalMs: 5,
      log: (l) => void log.push(l),
    });
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));

    await s.restartService("worker");
    expect(signals).toEqual(["SIGTERM"]);
    // 화면이 "정리 중"으로 잠긴다 — 버튼도 감독자도 같은 판정을 본다.
    const st = s.statuses()[0];
    expect(st.cleaningUp).toBe(true);
    expect(restartRefused(st)).toBe(true);
    expect(st.detail).toContain("내리는 중이에요");
    expect(st.detail).not.toContain("다시 시도");

    await s.restartService("worker");
    await s.restartService("worker");

    expect(signals).toEqual(["SIGTERM"]); // 두 번째·세 번째 요청은 신호를 보내지 않았다
    expect(log.some((l) => l.includes("두 번째 종료 신호는 강제 종료다"))).toBe(true);
    await s.stopAll({ graceMs: 5 });
  });

  it("runs one stop — and one bring — for two concurrent presses", async () => {
    // 겹친 두 번째 요청이 통과하면 두 가지가 벌어진다: 같은 pid에 두 번째 신호가 가거나(강제
    // 종료), 첫 번째가 rt.result를 이미 비운 뒤라 정지를 **건너뛰고** 곧장 bring해 아직 내려가는
    // 중인 자식 옆에 두 번째 인스턴스를 띄운다. 둘 다 여기서 막힌다.
    const signals: string[] = [];
    let launches = 0;
    const gate: { release?: () => void } = {};
    const s = createSupervisor(
      [
        stubbornSpec(signals, {
          launch: async () => {
            launches += 1;
            return { handle: fakeHandle(() => undefined), owned: true };
          },
          stop: async () => {
            signals.push("SIGTERM");
            // 첫 번째만 붙잡는다 — 뒤의 stopAll까지 막으면 테스트가 스스로 교착한다.
            if (signals.length === 1) await new Promise<void>((r) => (gate.release = r));
            return { stopped: false, leaked: [4242], detail: "아직 일하는 중" };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    expect(launches).toBe(1);

    const first = s.restartService("worker");
    const second = s.restartService("worker");
    await vi.waitFor(() => expect(signals).toEqual(["SIGTERM"]));
    gate.release?.();
    await Promise.all([first, second]);

    expect(signals).toEqual(["SIGTERM"]);
    expect(launches).toBe(1);
    expect(s.statuses()[0].cleaningUp).toBe(true);
    await s.stopAll({ graceMs: 5 });
  });

  it("allows a restart again once the process really exits", async () => {
    const signals: string[] = [];
    const spec0 = stubbornSpec(signals);
    const exits = (spec0 as ServiceSpec & { exits: ((code: number) => void)[] }).exits;
    const s = createSupervisor([spec0], ctx(), { readyTimeoutMs: 100, readyIntervalMs: 5 });
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));

    await s.restartService("worker");
    expect(s.statuses()[0].cleaningUp).toBe(true);

    // 늦게 끝났다 — worker가 job을 마치고 스스로 내려간 것이다.
    exits[0]?.(0);

    await vi.waitFor(() => expect(s.statuses()[0].cleaningUp).toBeUndefined());
    expect(restartRefused(s.statuses()[0])).toBe(false);
    // 보통은 평소의 사망 경로가 알아서 다시 띄운다.
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));
    expect(signals).toEqual(["SIGTERM"]);
    await s.stopAll({ graceMs: 5 });
  });

  it("does not lock a service whose exit it could not watch", async () => {
    // 핸들이 없으면 표시를 지워 줄 사건이 없다 — 영영 잠기는 대신 잠그지 않는다.
    const s = createSupervisor(
      [
        spec("postgres", {
          gate: false,
          launch: async () => ({ handle: null, owned: true }),
          stop: async () => ({ stopped: false, leaked: [] }),
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await vi.waitFor(() => expect(s.statuses()[0].process).toBe("running"));

    await s.restartService("postgres");

    expect(s.statuses()[0].cleaningUp).toBeUndefined();
    expect(restartRefused(s.statuses()[0])).toBe(false);
    await s.stopAll({ graceMs: 5 });
  });
});
