import { describe, expect, it, vi } from "vitest";
import { createSupervisor, orderOf } from "../src/services/supervisor";
import type {
  LaunchContext,
  LaunchResult,
  ReadinessResult,
  ServiceId,
  ServiceSpec,
} from "../src/services/types";

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

describe("supervisor.stopAll — 진행 중인 배경 기동 (C1)", () => {
  it("does not let a background bring create a process after stopAll returned", async () => {
    // launchWithUv도 launchDev도 detached다. stopAll이 반환한 **뒤에** 만들어진 자식은
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
    // postgres의 readiness는 docker compose ps를 돌리고 그 출력을 판다 — 파서가 던지면 여기로
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
