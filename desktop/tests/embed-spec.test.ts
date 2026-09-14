import { describe, expect, it } from "vitest";
import { embedSpec } from "../src/services/embed";
import { BLOCK_MAX_CHARS } from "../src/stderr";
import type { LaunchContext, ServiceHandle } from "../src/services/types";

function ctx(env: Record<string, string> = {}): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: { EMBED_SERVICE_HOST: "127.0.0.1", EMBED_SERVICE_PORT: "8100", ...env },
    bins: { uv: "/opt/homebrew/bin/uv" },
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
  };
}

describe("embedSpec.prepare", () => {
  it("derives the API's URL and the service's bind port from one value", async () => {
    // API는 EMBED_SERVICE_URL을, worker/embed는 HOST/PORT를 읽는다. 두 값을 따로
    // 관리하면 어긋나고, 어긋난 결과는 오류가 아니라 조용한 degrade다 (스펙 §6.4).
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    const env = await spec.prepare!(ctx());
    expect(env.EMBED_SERVICE_PORT).toBe("8100");
    expect(env.EMBED_SERVICE_URL).toBe("http://127.0.0.1:8100");
  });

  it("moves to a free port when something incompatible holds the default", async () => {
    const spec = embedSpec({
      probe: async () => ({ kind: "mismatch", detail: "모델 other/model" }),
      freePort: async () => 51234,
    });
    const env = await spec.prepare!(ctx());
    expect(env.EMBED_SERVICE_PORT).toBe("51234");
    expect(env.EMBED_SERVICE_URL).toBe("http://127.0.0.1:51234");
  });

  it("keeps the default port when a matching service already answers", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "match" }), freePort: async () => 51234 });
    const env = await spec.prepare!(ctx());
    expect(env.EMBED_SERVICE_PORT).toBe("8100");
  });
});

describe("embedSpec.detectExternal", () => {
  it("adopts a matching service", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "match" }), freePort: async () => 51234 });
    await spec.prepare!(ctx());
    expect((await spec.detectExternal(ctx())).kind).toBe("adopt");
  });

  it("does not adopt a mismatching service", async () => {
    const spec = embedSpec({
      probe: async () => ({ kind: "mismatch", detail: "모델 other/model" }),
      freePort: async () => 51234,
    });
    await spec.prepare!(ctx());
    expect((await spec.detectExternal(ctx())).kind).toBe("absent");
  });
});

describe("embedSpec shape", () => {
  it("is not a gate and does not depend on postgres", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    expect(spec.gate).toBe(false);
    expect(spec.dependsOn).toEqual([]);
  });

  it("keeps watching health after it is ready", () => {
    // 채택한 외부 embed가 내려가는 것도 이 경로로만 알아챈다.
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    expect(spec.healthIntervalMs).toBeGreaterThan(0);
  });

  it("allows far more than the default readiness window", () => {
    // 2026-09-12 실측 31초(따뜻한 캐시). 기본 60초는 캐시가 식으면 부족하다.
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    expect(spec.readyTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("bounds a dead embed's cause by characters too, keeping the end (리뷰 M-5)", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    const dead = {
      pid: 4242,
      alive: () => false,
      stderrTail: () => `${"x".repeat(8_000)}RuntimeError: boom`,
      exitCode: () => 1,
      onExit: () => undefined,
      stop: async () => undefined,
    } as unknown as ServiceHandle;
    const r = await spec.readiness({ handle: dead, owned: true }, ctx());
    const detail = r.kind === "failed" ? r.detail : "";
    expect(detail.length).toBe(BLOCK_MAX_CHARS + 1);
    expect(detail.endsWith("RuntimeError: boom")).toBe(true);
  });

  it("refuses to launch without uv", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    await expect(
      spec.launch({ ...ctx(), bins: { uv: null } }),
    ).rejects.toThrow(/uv/);
  });
});
