import { describe, expect, it, vi } from "vitest";
import { parseComposeStatus, postgresSpec } from "../src/services/postgres";
import type { LaunchContext } from "../src/services/types";

const HEALTHY = '{"Name":"damwha-postgres","Service":"postgres","State":"running","Health":"healthy"}';
const STARTING = '{"Name":"damwha-postgres","Service":"postgres","State":"running","Health":"starting"}';
const EXITED = '{"Name":"damwha-postgres","Service":"postgres","State":"exited","Health":""}';

function ctx(): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: {},
    bins: { uv: "/opt/homebrew/bin/uv", docker: "/usr/local/bin/docker" },
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
  };
}

describe("parseComposeStatus", () => {
  it("reads a healthy container", () => {
    expect(parseComposeStatus(HEALTHY)).toEqual({ kind: "healthy" });
  });

  it("reads a starting container", () => {
    expect(parseComposeStatus(STARTING)).toEqual({ kind: "starting" });
  });

  it("treats an exited container as absent", () => {
    expect(parseComposeStatus(EXITED)).toEqual({ kind: "absent" });
  });

  it("treats empty output as absent", () => {
    expect(parseComposeStatus("")).toEqual({ kind: "absent" });
    expect(parseComposeStatus("\n  \n")).toEqual({ kind: "absent" });
  });

  it("accepts a JSON array as well as JSONL", () => {
    expect(parseComposeStatus(`[${HEALTHY}]`)).toEqual({ kind: "healthy" });
  });

  it("reports unreadable output instead of guessing", () => {
    expect(parseComposeStatus("not json at all").kind).toBe("unreadable");
  });
});

describe("postgresSpec", () => {
  const ok: () => Promise<{ stdout: string; stderr: string; code: number }> = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
  });

  it("never restarts — compose owns that", () => {
    expect(postgresSpec(ok).restart).toBe("never");
  });

  it("keeps watching health after it is ready", () => {
    // 없으면 컨테이너가 내려가도 running/ok로 남는다 — P2-C11을 판정할 수 없다.
    expect(postgresSpec(ok).healthIntervalMs).toBeGreaterThan(0);
  });

  it("is a gate", () => {
    expect(postgresSpec(ok).gate).toBe(true);
  });

  it("reports the container as external when it is already healthy", async () => {
    const spec = postgresSpec(async () => ({ stdout: HEALTHY, stderr: "", code: 0 }));
    expect((await spec.detectExternal(ctx())).kind).toBe("adopt");
  });

  it("says absent when nothing is up yet", async () => {
    expect((await postgresSpec(ok).detectExternal(ctx())).kind).toBe("absent");
  });

  it("runs `up -d` on launch and never down/stop/rm", async () => {
    const calls: string[][] = [];
    const spec = postgresSpec(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    });
    await spec.launch(ctx());
    expect(calls.some((a) => a.includes("up") && a.includes("-d"))).toBe(true);
    expect(calls.flat()).not.toContain("down");
    expect(calls.flat()).not.toContain("stop");
    expect(calls.flat()).not.toContain("rm");
  });

  it("points compose at the repo's own file", async () => {
    const calls: string[][] = [];
    const spec = postgresSpec(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    });
    await spec.launch(ctx());
    expect(calls[0]).toContain("/r/be/docker-compose.yml");
  });

  it("reports the daemon being down as a failure that names the fix", async () => {
    // 2026-09-12 실측 문구(compose v5.5.0). 예전 Docker의 "Cannot connect to the Docker
    // daemon at …"도 같은 분기를 타야 한다.
    const spec = postgresSpec(async () => ({
      stdout: "",
      stderr:
        "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path " +
        "is correct and if the daemon is running: dial unix: connect: no such file or directory",
      code: 1,
    }));
    await expect(spec.launch(ctx())).rejects.toThrow(/Docker Desktop/);
  });

  it("also recognises the older Docker wording", async () => {
    const spec = postgresSpec(async () => ({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      code: 1,
    }));
    await expect(spec.launch(ctx())).rejects.toThrow(/Docker Desktop/);
  });

  it("stops nothing — the container outlives the app", async () => {
    const run = vi.fn(ok);
    const spec = postgresSpec(run);
    run.mockClear();
    expect(await spec.stop({ handle: null, owned: true }, { graceMs: 10 })).toEqual({
      stopped: true,
      leaked: [],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("is ready only when healthy", async () => {
    const ready = postgresSpec(async () => ({ stdout: HEALTHY, stderr: "", code: 0 }));
    expect((await ready.readiness({ handle: null, owned: true }, ctx())).kind).toBe("ready");
    const starting = postgresSpec(async () => ({ stdout: STARTING, stderr: "", code: 0 }));
    expect((await starting.readiness({ handle: null, owned: true }, ctx())).kind).toBe("not-ready");
  });

  it("raises an unreadable status to failed, not not-ready", async () => {
    // not-ready로 두면 데몬이 꺼진 상태에서 유예가 다 찰 때까지 아무 설명도 안 보인다.
    const spec = postgresSpec(async () => ({ stdout: "garbage", stderr: "", code: 0 }));
    expect((await spec.readiness({ handle: null, owned: true }, ctx())).kind).toBe("failed");
  });
});
