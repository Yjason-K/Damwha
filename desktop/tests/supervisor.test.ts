import { describe, expect, it, vi } from "vitest";
import { createSupervisor, orderOf } from "../src/services/supervisor";
import type { LaunchContext, ServiceId, ServiceSpec } from "../src/services/types";

function ctx(): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: false,
    env: {},
    bins: { uv: "/opt/homebrew/bin/uv", docker: "/usr/local/bin/docker" },
    searchDirs: ["/opt/homebrew/bin"],
    logFile: (id) => `/u/logs/${id}.log`,
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
    // start()가 embed의 200ms를 기다렸다면 api는 그 뒤에 온다. 기다리지 않았으면 둘 다 즉시.
    expect(order).toEqual(["embed", "api"]);
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
