import { EventEmitter } from "events";
import type { SpawnOptions } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiChildEnv, launchDev, launchPackaged } from "../../src/services/api-process";
import { fakeChild } from "../fake-child";

/**
 * API 자식이 **실제로** 받는 env (R-6b). 두 런처의 스폰 호출을 가로채 그 env를 본다 — 합성 함수만 테스트하면
 * 런처가 그것을 부르지 않아도 초록이다.
 *
 * 앱은 HF 토큰을 쓰지 않는다(스펙 2026-09-30 §5.1). 개발자 셸에서 상속된 HF_TOKEN도 API에는 가지 않는다.
 */
const SHELL_TOKEN = "hf_fromTheDeveloperShell000000000";
const LIVE = { PORT: "3001", DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu%2Frun", HOST: "0.0.0.0" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiChildEnv", () => {
  it("drops an inherited HF_TOKEN, keeps the rest, and pins HOST last", () => {
    const env = apiChildEnv(LIVE, "dev", { HF_TOKEN: SHELL_TOKEN, PATH: "/usr/bin:/bin", HOST: "0.0.0.0" });
    expect("HF_TOKEN" in env).toBe(false);
    expect(env).toMatchObject({ PORT: "3001", DATABASE_URL: LIVE.DATABASE_URL, PATH: "/usr/bin:/bin", HOST: "127.0.0.1" });
    expect(JSON.stringify(env)).not.toContain("hf_");
  });

  it("dev: ALLOWED_ORIGINS is the Vite origin whatever the shell or config says, ALLOWED_HOSTS is gone", () => {
    const env = apiChildEnv(
      { ...LIVE, ALLOWED_ORIGINS: "https://evil.example", ALLOWED_HOSTS: "evil.example" },
      "dev",
      { ALLOWED_ORIGINS: "https://shell.example", ALLOWED_HOSTS: "shell.example" },
    );
    expect(env.ALLOWED_ORIGINS).toBe("http://localhost:5173");
    expect("ALLOWED_HOSTS" in env).toBe(false);
  });

  it("packaged: neither key survives — the renderer is same-origin with the API", () => {
    const env = apiChildEnv(
      { ...LIVE, ALLOWED_ORIGINS: "https://evil.example" },
      "packaged",
      { ALLOWED_ORIGINS: "https://shell.example", ALLOWED_HOSTS: "shell.example" },
    );
    expect("ALLOWED_ORIGINS" in env).toBe(false);
    expect("ALLOWED_HOSTS" in env).toBe(false);
    expect(env.HOST).toBe("127.0.0.1");
  });
});

describe("launchDev", () => {
  it("spawns the dev API without HF_TOKEN, even when the shell carries one", () => {
    vi.stubEnv("HF_TOKEN", SHELL_TOKEN);
    vi.stubEnv("ALLOWED_ORIGINS", "https://shell.example");
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
    expect(env.ALLOWED_ORIGINS).toBe("http://localhost:5173");
    // 상속분은 그대로 간다 — pnpm·nest가 PATH·HOME을 쓴다.
    expect(env.PATH).toBe(process.env.PATH);
    expect(seen?.detached).toBe(true);
    child.emit("exit", 0);
  });
});

describe("launchPackaged", () => {
  it("forks the bundled API without HF_TOKEN, even when the shell carries one", () => {
    vi.stubEnv("HF_TOKEN", SHELL_TOKEN);
    vi.stubEnv("ALLOWED_ORIGINS", "https://shell.example");
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
    expect("ALLOWED_ORIGINS" in env).toBe(false);
    // packaged도 상속 env를 준다 — env를 주면 환경이 통째로 대체된다(PATH 없는 API가 sysctl을 못 찾았다).
    expect(env.PATH).toBe(process.env.PATH);
    child.emit("exit", 0);
  });
});
