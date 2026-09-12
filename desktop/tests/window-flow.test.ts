import { describe, expect, it } from "vitest";
import { openWindowFlow, type WindowFlowDeps } from "../src/window-flow";

/** 잎만 가짜다. 판정 대상인 순서는 진짜 코드가 정한다. */
function recorder(over: Partial<WindowFlowDeps> = {}) {
  const log: string[] = [];
  const deps: WindowFlowDeps = {
    showShell: async () => void log.push("shell"),
    attach: async () => void log.push("attach"),
    onFailure: async () => void log.push("failure"),
    ...over,
  };
  return { log, deps };
}

describe("openWindowFlow", () => {
  it("shows the shell screen before it attempts to attach", async () => {
    // 붙이기가 먼저면 그동안 창은 빈 흰 화면이다 — dev에서 Vite가 죽어 있으면 최대 30초.
    const { log, deps } = recorder();
    await openWindowFlow(deps);
    expect(log).toEqual(["shell", "attach"]);
  });

  it("turns a rejected attach into the failure path, with the reason", async () => {
    // Task 12는 이 거부를 supervisor.log 한 줄로 끝냈다 — 창은 빈 채로 영구히 남았다.
    const seen: unknown[] = [];
    const boom = new Error("ERR_CONNECTION_REFUSED");
    const { log, deps } = recorder({
      attach: async () => {
        log.push("attach");
        throw boom;
      },
      onFailure: async (e) => {
        log.push("failure");
        seen.push(e);
      },
    });
    await openWindowFlow(deps);
    expect(log).toEqual(["shell", "attach", "failure"]);
    expect(seen).toEqual([boom]);
  });

  it("does not reach the failure path when attaching works", async () => {
    const { log, deps } = recorder();
    await openWindowFlow(deps);
    expect(log).not.toContain("failure");
  });

  it("still attempts to attach when the shell screen could not be shown", async () => {
    // loadFile이 거부해도(파괴된 창, 없는 파일) 붙이기는 남은 유일한 화면 경로다.
    const { log, deps } = recorder({
      showShell: async () => {
        log.push("shell");
        throw new Error("shell gone");
      },
    });
    await openWindowFlow(deps);
    expect(log).toEqual(["shell", "attach"]);
  });
});
