import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { embedSpec } from "../../src/services/embed";
import { BLOCK_MAX_CHARS } from "../../src/diagnostics/stderr";
import type { LaunchContext, ServiceHandle } from "../../src/services/types";
import { fakeChild } from "../fake-child";

function ctx(env: Record<string, string> = {}): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    databaseMode: "embedded",
    env: { EMBED_SERVICE_HOST: "127.0.0.1", EMBED_SERVICE_PORT: "8100", ...env },
    bins: { python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test",
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

  it("launches the embed service by module, not the damwha-embed console script, run-id last (Phase 4 스펙 §6.2)", async () => {
    // 콘솔 스크립트는 셔뱅을 타 옛 경로가 남아 있으면 조용히 다른 런타임을 실행한다 (Phase 0 R-6).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-embed-"));
    try {
      const child = fakeChild();
      const spawnFn = vi.fn().mockReturnValue(child);
      const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100, spawnFn });
      await spec.prepare!(ctx());
      const c = { ...ctx(), logFile: (id: string) => path.join(dir, `${id}.log`) };
      const result = await spec.launch(c);
      expect(result.owned).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      const [command, args] = spawnFn.mock.calls[0] as [string, string[]];
      expect(command).toBe("/b/python/bin/python3.12");
      expect(args).toEqual(["-m", "damwha_worker.embed_service", "--run-id=desktop-test"]);
      child.emit("exit", 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not launch anything when it adopted a matching external service", async () => {
    const spawnFn = vi.fn();
    const spec = embedSpec({ probe: async () => ({ kind: "match" }), freePort: async () => 8100, spawnFn });
    await spec.prepare!(ctx());
    expect(await spec.launch(ctx())).toEqual({ handle: null, owned: false });
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
