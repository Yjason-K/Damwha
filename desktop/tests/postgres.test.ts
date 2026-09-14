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
    bins: { uv: "/opt/homebrew/bin/uv" },
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
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

  it("finds postgres among several JSONL rows", () => {
    const other = '{"Name":"damwha-redis","Service":"redis","State":"running","Health":""}';
    expect(parseComposeStatus(`${other}\n${HEALTHY}`)).toEqual({ kind: "healthy" });
  });

  it("says absent when the compose file has other services but no postgres", () => {
    const other = '{"Name":"damwha-redis","Service":"redis","State":"running","Health":""}';
    expect(parseComposeStatus(other)).toEqual({ kind: "absent" });
    // 필드가 빠진 행도 행이다 — 객체이기만 하면 "우리가 찾는 서비스가 아니다"로 읽는다.
    expect(parseComposeStatus('{"Name":"damwha-postgres"}')).toEqual({ kind: "absent" });
  });

  it("treats a running container with no health verdict as starting", () => {
    // Health가 아예 없는 것과 빈 문자열인 것은 같은 뜻이다 — 아직 healthy라고 말한 적이 없다.
    expect(parseComposeStatus('{"Service":"postgres","State":"running"}')).toEqual({
      kind: "starting",
    });
    expect(parseComposeStatus('{"Service":"postgres","State":"running","Health":""}')).toEqual({
      kind: "starting",
    });
  });

  it("reports unreadable when one line of JSONL is malformed", () => {
    // 세 줄 중 가운데만 깨졌다. 앞줄이 우연히 postgres였다고 해서 판정하면 안 된다 — 출력을
    // 못 읽은 것이지, 컨테이너 상태를 읽은 것이 아니다.
    const broken = `${HEALTHY}\n{"Service":"postgres", oops\n${EXITED}`;
    expect(parseComposeStatus(broken).kind).toBe("unreadable");
  });

  it("never throws on JSON that is valid but is not a row", () => {
    // `null`은 JSON으로 멀쩡해서 try/catch를 지나간 뒤 r.Service에서 TypeError를 던졌다.
    // 던지면 readiness가 던지고, 그것은 기동 시퀀스를 세운다 — 어떤 입력에도 값으로 답한다.
    for (const input of ["null", "true", "false", "42", '"x"', "[null]", "[1,2]", '["x"]']) {
      const state = parseComposeStatus(input);
      // 객체가 아닌 행은 깨진 출력이다. absent로 내려 보내면 사람은 준비 유예가 다 찰 때까지
      // 아무 설명도 못 보고, 원문도 잃는다.
      expect({ input, kind: state.kind }).toEqual({ input, kind: "unreadable" });
      expect(state.kind === "unreadable" && state.detail).toBe(input);
    }
  });

  it("says absent for an empty JSON array — nothing is up", () => {
    expect(parseComposeStatus("[]")).toEqual({ kind: "absent" });
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

  it("asks for stopped containers too — `ps -a`", async () => {
    // 2026-09-12 실측: 멈춘 컨테이너는 `ps`에 **아예 나오지 않고** `ps -a`에만
    // State:"exited"로 나온다. -a가 빠지면 어댑터는 exited를 영영 관측하지 못하고, 내려간
    // 컨테이너가 "absent"와 구분되지 않는다. `up -d`와 달리 이 플래그는 출력으로 티가 나지
    // 않으므로 여기서 못 박는다.
    const calls: string[][] = [];
    const spec = postgresSpec(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    });
    await spec.detectExternal(ctx());
    await spec.readiness({ handle: null, owned: true }, ctx());
    expect(calls.length).toBe(2);
    for (const args of calls) {
      expect(args).toContain("ps");
      expect(args).toContain("-a");
    }
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
