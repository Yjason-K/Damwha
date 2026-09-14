import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchWithUv } from "../../src/services/worker";
import type { LaunchContext } from "../../src/services/types";
import type { SpawnOptions } from "child_process";
import { fakeChild } from "../fake-child";

/**
 * worker·embed 어댑터 테스트는 전부 가짜 handle을 주입해 launchWithUv 자체는 한 번도
 * 실행하지 않는다 — 리뷰가 실측한 두 구멍(detached: true, 'error' 리스너)이 그래서
 * 179개 테스트 전부를 통과한 채로 숨어 있었다. 여기서는 spawnFn을 주입해 진짜
 * child_process.spawn 없이 launchWithUv가 부르는 인자와 등록하는 리스너를 직접 본다.
 */

let tmpDir: string;

function ctx(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: {},
    bins: { uv: "/opt/homebrew/bin/uv" },
    searchDirs: [],
    logFile: (id) => path.join(tmpDir, `${id}.log`),
    signal: new AbortController().signal,
    ...over,
  } as LaunchContext;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("launchWithUv", () => {
  it("stop()은 SIGTERM을 uv의 pid 하나로 보낸다 — 그룹으로 보내면 uv의 전달과 겹쳐 자식이 두 번 받는다", async () => {
    // 2026-09-13 실측: uv run 아래 자식에 그룹 SIGTERM 1회 → 핸들러 2회(커널 한 번, uv 전달 한 번).
    // worker supervisor는 두 번째를 강제로 읽고, embed(uvicorn)는 지금 버전이 우연히 그러지 않을
    // 뿐이다. 진짜 신호가 나가지 않게 process.kill을 가로챈다 — 4242는 이 기계에 실재할 수 있는 pid다.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-launch-"));
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const kills: Array<[number, string | number | undefined]> = [];
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      kills.push([pid, sig]);
      return true;
    });
    try {
      const { handle } = launchWithUv({ ctx: ctx(), args: ["damwha-embed"], logId: "embed", spawnFn });
      if (handle === null) throw new Error("handle이 없다");
      // 신호를 받자마자 끝나는 자식을 흉내 낸다. 유예 루프가 한 바퀴 안에 빠져나온다.
      const stopping = handle.stop(1_000);
      child.emit("exit", 0);
      await stopping;
    } finally {
      spy.mockRestore();
    }
    expect(kills).toEqual([[4242, "SIGTERM"]]);
  });

  it("detached: true로 띄운다 — 없으면 uv와 Python이 Electron의 그룹에 들어가 그룹 신호가 종료 절차를 건너뛴다", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-launch-"));
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    launchWithUv({ ctx: ctx(), args: ["python", "-m", "damwha_worker"], logId: "worker", spawnFn });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const passedOptions = spawnFn.mock.calls[0][2] as SpawnOptions;
    expect(passedOptions.detached).toBe(true);

    child.emit("exit", 0);
  });

  it("'error' 리스너를 단다 — 없으면 spawn 실패가 EventEmitter를 통해 Electron main을 통째로 죽인다", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-launch-"));
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    launchWithUv({ ctx: ctx(), args: ["damwha-embed"], logId: "embed", spawnFn });

    // 리스너가 없으면 Node의 EventEmitter가 'error' 이벤트를 동기로 다시 던진다.
    expect(() => child.emit("error", new Error("spawn boom"))).not.toThrow();
  });

  it("stdout과 stderr를 별도 꼬리에 쌓는다 — worker의 ready 줄(stderr)이 embed 접근 로그(stdout)에 섞이지 않는다", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-launch-"));
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    const result = launchWithUv({ ctx: ctx(), args: ["damwha-embed"], logId: "embed", spawnFn });
    const handle = result.handle;
    if (handle === null) throw new Error("handle이 없다");

    child.stdout.emit("data", Buffer.from("GET /health 200 OK\n"));
    child.stderr.emit("data", Buffer.from("Traceback: 실패\n"));

    expect(handle.stdoutTail()).toContain("GET /health 200 OK");
    expect(handle.stdoutTail()).not.toContain("Traceback");
    expect(handle.stderrTail()).toContain("Traceback");
    expect(handle.stderrTail()).not.toContain("GET /health");

    child.emit("exit", 0);
  });
});
