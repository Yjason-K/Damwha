import { EventEmitter } from "events";
import type { SpawnOptions } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiChildEnv, launchDev, launchPackaged } from "../../src/services/api-process";
import { fakeChild } from "../fake-child";

/**
 * API 자식이 **실제로** 받는 env (R-6b). 두 런처의 스폰 호출을 가로채 그 env를 본다 — 합성 함수만 테스트하면
 * 런처가 그것을 부르지 않아도 초록이다.
 *
 * HF_TOKEN은 Python 자식(worker·embed)만 받는다. API는 토큰을 쓰지 않는다. 감독자의 ctx.env(api.ts가
 * `{ ...ctx.env, PORT }`로 넘긴다)에 들어 있어도, 개발자 셸에서 상속돼도 API에는 가지 않는다.
 */
const TOKEN = "hf_KeychainTokenValue0123456789abcd";
const SHELL_TOKEN = "hf_fromTheDeveloperShell000000000";
const LIVE = { HF_TOKEN: TOKEN, PORT: "3001", DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu%2Frun", HOST: "0.0.0.0" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiChildEnv", () => {
  it("drops HF_TOKEN from the live and the inherited env, keeps the rest, and pins HOST last", () => {
    const env = apiChildEnv(LIVE, { HF_TOKEN: SHELL_TOKEN, PATH: "/usr/bin:/bin", HOST: "0.0.0.0" });
    expect("HF_TOKEN" in env).toBe(false);
    expect(env).toMatchObject({ PORT: "3001", DATABASE_URL: LIVE.DATABASE_URL, PATH: "/usr/bin:/bin", HOST: "127.0.0.1" });
    expect(JSON.stringify(env)).not.toContain("hf_");
  });
});

describe("launchDev", () => {
  it("spawns the dev API without HF_TOKEN, even when the shell and the live env both carry one", () => {
    vi.stubEnv("HF_TOKEN", SHELL_TOKEN);
    let seen: SpawnOptions | undefined;
    const child = fakeChild();
    const handle = launchDev({
      entry: "/r/be/dist/main.js",
      cwd: "/r",
      env: LIVE,
      spawnFn: (_cmd, _args, opts) => {
        seen = opts;
        return child;
      },
    });
    expect(handle.pid).toBe(4242);
    const env = (seen?.env ?? {}) as Record<string, string | undefined>;
    expect("HF_TOKEN" in env).toBe(false);
    expect(env.PORT).toBe("3001");
    expect(env.DATABASE_URL).toBe(LIVE.DATABASE_URL);
    expect(env.HOST).toBe("127.0.0.1");
    // 상속분은 그대로 간다 — pnpm·nest가 PATH·HOME을 쓴다.
    expect(env.PATH).toBe(process.env.PATH);
    expect(seen?.detached).toBe(true);
    // 감독자가 쥔 env는 건드리지 않는다 — worker·embed는 그 토큰을 받는다.
    expect(LIVE.HF_TOKEN).toBe(TOKEN);
    child.emit("exit", 0);
  });
});

describe("launchPackaged", () => {
  it("forks the bundled API without HF_TOKEN, even when the shell and the live env both carry one", () => {
    vi.stubEnv("HF_TOKEN", SHELL_TOKEN);
    let seen: Electron.ForkOptions | undefined;
    const child = Object.assign(new EventEmitter(), {
      pid: 5151,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true,
    });
    const handle = launchPackaged({
      entry: "/app/Resources/api/dist/main.js",
      cwd: "/app/Resources/api",
      env: LIVE,
      forkFn: (_modulePath, _args, opts) => {
        seen = opts;
        return child as unknown as Electron.UtilityProcess;
      },
    });
    expect(handle.pid).toBe(5151);
    const env = (seen?.env ?? {}) as Record<string, string | undefined>;
    expect("HF_TOKEN" in env).toBe(false);
    expect(env.PORT).toBe("3001");
    expect(env.DATABASE_URL).toBe(LIVE.DATABASE_URL);
    expect(env.HOST).toBe("127.0.0.1");
    // packaged도 상속 env를 준다 — env를 주면 환경이 통째로 대체된다(PATH 없는 API가 sysctl을 못 찾았다).
    expect(env.PATH).toBe(process.env.PATH);
    child.emit("exit", 0);
  });
});
