import { describe, expect, it, vi } from "vitest";
import { probeHealth, waitForReady } from "../src/readiness";

const never = () => Promise.resolve<never>(undefined as never);

function harness(results: Array<"ready" | "db-unreachable" | "no-response">, alive = true) {
  const calls: number[] = [];
  let clock = 0;
  return {
    calls,
    options: {
      probe: async () => results.shift() ?? "no-response",
      isAlive: () => alive,
      timeoutMs: 1000,
      intervalMs: 100,
      sleep: async (ms: number) => {
        calls.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  };
}

describe("waitForReady", () => {
  it("returns ready on the first successful probe", async () => {
    const h = harness(["ready"]);
    expect(await waitForReady(h.options)).toEqual({ kind: "ready" });
    expect(h.calls).toEqual([]);
  });

  it("keeps polling while there is no response", async () => {
    const h = harness(["no-response", "no-response", "ready"]);
    expect(await waitForReady(h.options)).toEqual({ kind: "ready" });
    expect(h.calls).toEqual([100, 100]);
  });

  it("reports db-unreachable without waiting further", async () => {
    const h = harness(["db-unreachable"]);
    expect(await waitForReady(h.options)).toEqual({ kind: "db-unreachable" });
  });

  it("gives up when the deadline passes", async () => {
    const h = harness([]);
    expect(await waitForReady(h.options)).toEqual({ kind: "timeout" });
  });

  it("times out even when a probe never settles", async () => {
    // 연결은 됐지만 응답이 없는 API가 이 형태다. probe 반환 뒤에만 deadline을 보면
    // 영원히 매달린다.
    const outcome = await waitForReady({
      probe: () => new Promise<never>(() => {}),
      isAlive: () => true,
      timeoutMs: 60,
      intervalMs: 10,
      probeTimeoutMs: 20,
    });
    expect(outcome).toEqual({ kind: "timeout" });
  }, 2_000);

  it("stops immediately when the child is gone and never probes", async () => {
    const probe = vi.fn(never);
    const outcome = await waitForReady({
      probe,
      isAlive: () => false,
      timeoutMs: 1000,
      intervalMs: 100,
      sleep: async () => {},
      now: () => 0,
    });
    expect(outcome).toEqual({ kind: "child-exited" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("notices the child dying between probes", async () => {
    let alive = true;
    const outcome = await waitForReady({
      probe: async () => "no-response",
      isAlive: () => alive,
      timeoutMs: 1000,
      intervalMs: 100,
      sleep: async () => {
        alive = false;
      },
      now: () => 0,
    });
    expect(outcome).toEqual({ kind: "child-exited" });
  });
});

describe("probeHealth", () => {
  it("maps 200 to ready", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => ({ status: 200 }) as Response);
    expect(r).toBe("ready");
  });

  it("maps 503 to db-unreachable — the API is up but the DB is not", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => ({ status: 503 }) as Response);
    expect(r).toBe("db-unreachable");
  });

  it("maps a refused connection to no-response", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => {
      throw new Error("fetch failed");
    });
    expect(r).toBe("no-response");
  });

  it("gives up on a request that never settles", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", () => new Promise<never>(() => {}), 30);
    expect(r).toBe("no-response");
  }, 2_000);

  it("maps any other status to no-response", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => ({ status: 404 }) as Response);
    expect(r).toBe("no-response");
  });

  it("asks for /api/health under the given base", async () => {
    let asked = "";
    await probeHealth("http://127.0.0.1:4100", async (url) => {
      asked = String(url);
      return { status: 200 } as Response;
    });
    expect(asked).toBe("http://127.0.0.1:4100/api/health");
  });
});
