import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchWithUv } from "../src/services/worker";
import type { LaunchContext } from "../src/services/types";
import type { ChildProcess, SpawnOptions } from "child_process";

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
    bins: { uv: "/opt/homebrew/bin/uv", docker: null },
    searchDirs: [],
    logFile: (id) => path.join(tmpDir, `${id}.log`),
    ...over,
  } as LaunchContext;
}

/**
 * 진짜 child_process.ChildProcess 대신 쓰는 가짜. stdout·stderr를 별도 EventEmitter로
 * 두어야 launchWithUv가 각각에 다는 리스너를 실제 ChildProcess와 같은 모양으로 태울 수
 * 있다. EventEmitter 자체가 'error' 이벤트를 리스너 없이 emit하면 동기로 다시 던지는
 * 성질을 이용해 "'error' 리스너가 달려 있는가"를 검증한다.
 */
function fakeChild(): ChildProcess & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 4242,
    kill: () => true,
  });
  return child;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("launchWithUv", () => {
  it("detached: true로 띄운다 — 없으면 process.kill(-pid)가 그룹을 못 찾아 종료 시 고아가 남는다", () => {
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
