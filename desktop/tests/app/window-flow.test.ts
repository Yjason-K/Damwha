import { describe, expect, it } from "vitest";
import { decideMenuRetry, gateUp, openWindowFlow, type WindowFlowDeps } from "../../src/app/window-flow";
import { mayAutoRetry } from "../../src/app/retry-policy";
import type { ServiceStatus } from "../../src/services/types";

/**
 * 잎만 가짜다. 판정 대상인 순서는 진짜 코드가 정한다.
 *
 * 가짜가 **비동기이고, 들어간 것과 나온 것을 따로 적는** 것이 이 파일의 판정 절반이다.
 * 예전 가짜는 log.push를 동기로 했고, 그래서 `await deps.showShell()`을
 * `void deps.showShell()`로 바꿔도 기록되는 순서가 그대로라 어설션이 하나도 깨지지 않았다
 * (재리뷰 §4-4: 259 passed). 비동기로만 바꾸는 것으로도 부족하다 — 두 가짜가 같은 틱에
 * 깨어나면 등록 순서대로 끝나 순서가 또 그대로다(실측: 294 passed로 살아남았다).
 *
 * 프로덕션에서 그 편집이 내는 것은 순서 뒤바뀜이 아니라 **겹침**이다: 같은 창에 loadFile과
 * loadURL이 동시에 걸리고, 밀려난 쪽이 ERR_ABORTED로 거부되는데 아무도 잡지 않아 Electron
 * main의 unhandled rejection이 된다(openWindowFlow의 catch는 await가 있을 때만 그것을 받는다).
 * 그래서 겹침 자체를 기록한다 — `shell:start`가 `shell:end`보다 먼저 닫히지 않으면 빨개진다.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 겹치지 않고 차례로 돈 잎들의 기록. */
const seq = (...names: string[]) => names.flatMap((n) => [`${n}:start`, `${n}:end`]);

function recorder(over: Partial<WindowFlowDeps> = {}) {
  const log: string[] = [];
  const record = (what: string) => async () => {
    log.push(`${what}:start`);
    await tick();
    log.push(`${what}:end`);
  };
  const deps: WindowFlowDeps = {
    showShell: record("shell"),
    readyToAttach: () => true,
    start: record("start"),
    attach: record("attach"),
    onFailure: record("failure"),
    autoRetryAllowed: () => true,
    ...over,
  };
  return { log, deps };
}

describe("openWindowFlow", () => {
  it("shows the shell screen before it attempts to attach", async () => {
    // 붙이기가 먼저면 그동안 창은 빈 흰 화면이다 — dev에서 Vite가 죽어 있으면 최대 30초.
    const { log, deps } = recorder();
    await openWindowFlow(deps);
    expect(log).toEqual(seq("shell", "attach"));
  });

  it("turns a rejected attach into the failure path, with the reason", async () => {
    // Task 12는 이 거부를 supervisor.log 한 줄로 끝냈다 — 창은 빈 채로 영구히 남았다.
    const seen: unknown[] = [];
    const boom = new Error("ERR_CONNECTION_REFUSED");
    const { log, deps } = recorder({
      attach: async () => {
        log.push("attach:start");
        await tick();
        throw boom;
      },
      onFailure: async (e) => {
        log.push("failure:start");
        await tick();
        seen.push(e);
        log.push("failure:end");
      },
    });
    await openWindowFlow(deps);
    expect(log).toEqual([...seq("shell"), "attach:start", ...seq("failure")]);
    expect(seen).toEqual([boom]);
  });

  it("does not reach the failure path when attaching works", async () => {
    const { log, deps } = recorder();
    await openWindowFlow(deps);
    expect(log.join(" ")).not.toContain("failure");
  });

  it("still attempts to attach when the shell screen could not be shown", async () => {
    // loadFile이 거부해도(파괴된 창, 없는 파일) 붙이기는 남은 유일한 화면 경로다.
    const { log, deps } = recorder({
      showShell: async () => {
        log.push("shell:start");
        await tick();
        throw new Error("shell gone");
      },
    });
    await openWindowFlow(deps);
    expect(log).toEqual(["shell:start", ...seq("attach")]);
  });

  it("starts the services when none are running instead of attaching to nothing", async () => {
    // 재리뷰 §4-3. 첫 기동이 감독자를 세우기 전에 접히면(폴더 선택 대화상자 중 창 닫기)
    // 창을 다시 열어도 붙일 것이 없다. start()를 부르지 않으면 서비스 줄이 한 줄도 없는
    // 빈 "준비 중" 화면에 영구히 서고, 탈출구는 메뉴의 "다시 시도"뿐이다.
    const { log, deps } = recorder({ readyToAttach: () => false });
    await openWindowFlow(deps);
    expect(log).toEqual(seq("shell", "start"));
  });

  it("does not attach when there is nothing to attach to", async () => {
    // reattachWindow는 감독자가 없으면 빈 준비 화면을 다시 걸 뿐이다. 그 길로 가면
    // start()가 영영 안 불린다.
    const { log, deps } = recorder({ readyToAttach: () => false });
    await openWindowFlow(deps);
    expect(log.join(" ")).not.toContain("attach");
  });

  it("waits for the shell screen before starting the services", async () => {
    const { log, deps } = recorder({ readyToAttach: () => false });
    await openWindowFlow(deps);
    // 셸이 **닫힌 뒤에** start가 시작한다 — 겹치면 start의 준비 화면을 이 loadFile이 덮는다.
    expect(log.slice(0, 3)).toEqual([...seq("shell"), "start:start"]);
  });

  it("lets a rejected onFailure reach the caller — that log line is the only record", async () => {
    // 재리뷰 §4-5. 여기서 삼키면 main.ts의 .catch 한 줄이 죽는다. 그 줄은 "붙이기도 실패했고
    // 실패 처리도 실패했다"는 이중 실패의 유일한 기록이고, 하필 화면이 이미 잘못된 순간이다.
    const boom = new Error("failure screen is gone too");
    const { deps } = recorder({
      attach: async () => {
        await tick();
        throw new Error("ERR_CONNECTION_REFUSED");
      },
      onFailure: async () => {
        await tick();
        throw boom;
      },
    });
    await expect(openWindowFlow(deps)).rejects.toBe(boom);
  });

  it("lets a rejected start reach the caller too", async () => {
    const boom = new Error("start blew up");
    const { deps } = recorder({
      readyToAttach: () => false,
      start: async () => {
        await tick();
        throw boom;
      },
    });
    await expect(openWindowFlow(deps)).rejects.toBe(boom);
  });
});

describe("decideMenuRetry — 창이 없을 때 메뉴의 재시도가 유일한 복구다 (Task 14)", () => {
  it("opens a window first when there is none — start() alone returns at `win === null`", () => {
    expect(decideMenuRetry({ quitting: false, hasWindow: false })).toBe("open-window");
  });

  it("just starts when a window is there", () => {
    expect(decideMenuRetry({ quitting: false, hasWindow: true })).toBe("start");
  });

  it("does nothing while quitting, with or without a window", () => {
    expect(decideMenuRetry({ quitting: true, hasWindow: true })).toBe("ignore");
    expect(decideMenuRetry({ quitting: true, hasWindow: false })).toBe("ignore");
  });
});

describe("창을 다시 열 때 넘어진 게이트 — 재시도를 되살린다 (Task 14 fix 1-4)", () => {
  const st = (id: ServiceStatus["id"], process: ServiceStatus["process"]): ServiceStatus => ({
    id,
    process,
    health: process === "running" ? "ok" : "unknown",
    owned: true,
    restarts: 0,
  });

  it("gateUp is true only when the API is running (degraded counts as up)", () => {
    expect(gateUp(null)).toBe(false);
    expect(gateUp([])).toBe(false);
    expect(gateUp([st("postgres", "running")])).toBe(false);
    for (const p of ["failed", "starting", "stopped"] as const) {
      expect(gateUp([st("postgres", "running"), st("api", p)])).toBe(false);
    }
    expect(gateUp([st("postgres", "running"), st("api", "running")])).toBe(true);
    expect(gateUp([{ ...st("api", "running"), health: "degraded" }])).toBe(true);
  });

  it("reopening after postgres failed starts (retries) instead of attaching to nothing", async () => {
    // 창이 없는 동안 자동 재시도는 헛돌았다. 기동으로 가야 재시도가 다시 돌고, 화면의 카운트다운이
    // 실제로 걸린 타이머에서 나온다.
    const failed = [st("postgres", "failed"), st("api", "stopped"), st("embed", "running"), st("worker", "stopped")];
    const { log, deps } = recorder({ readyToAttach: () => gateUp(failed) });
    await openWindowFlow(deps);
    expect(log).toEqual(seq("shell", "start"));
  });

  it("reopening with the API up attaches, even if a background service failed", async () => {
    const up = [st("postgres", "running"), st("api", "running"), st("embed", "failed"), st("worker", "running")];
    const { log, deps } = recorder({ readyToAttach: () => gateUp(up) });
    await openWindowFlow(deps);
    expect(log).toEqual(seq("shell", "attach"));
  });
});

describe("창을 다시 열 때 manual 실패는 재시도하지 않는다 (Task 12 fix round 1, 스펙 §6.7)", () => {
  it("does not start when the gate is down for a manual reason — the retry button is the only way back", async () => {
    // 마이그레이션 게이트 같은 manual 실패다. 창을 여닫을 때마다 start()가 다시 돌면 게이트가
    // 또 실행돼 백업이 하나씩 쌓인다. 셸은 이미 위에서 걸었으니 화면이 비지는 않는다.
    const { log, deps } = recorder({ readyToAttach: () => false, autoRetryAllowed: () => false });
    await openWindowFlow(deps);
    expect(log).toEqual(seq("shell"));
  });

  it("still starts when the gate is down for an auto-recoverable reason", async () => {
    const { log, deps } = recorder({ readyToAttach: () => false, autoRetryAllowed: () => true });
    await openWindowFlow(deps);
    expect(log).toEqual(seq("shell", "start"));
  });

  it("still starts when there is no supervisor yet — autoRetryAllowed mirrors mayAutoRetry(null)", async () => {
    // main.ts는 `mayAutoRetry(supervisor?.statuses() ?? null)`로 잇는다. 감독자가 없으면
    // statuses가 null이고, mayAutoRetry(null)은 항상 true다 — 창을 다시 열어도 첫 기동이
    // 감독자를 세우기 전에 접힌 경우까지 막히면 안 된다.
    const { log, deps } = recorder({ readyToAttach: () => false, autoRetryAllowed: () => mayAutoRetry(null) });
    await openWindowFlow(deps);
    expect(log).toEqual(seq("shell", "start"));
  });

  it("the menu retry starts regardless of the failure class", () => {
    // decideMenuRetry는 autoRetryAllowed를 보지 않는다 — 사람이 누른 재시도는 manual이든
    // auto든 항상 통과시킨다(스펙 §6.7의 "탈출구").
    expect(decideMenuRetry({ quitting: false, hasWindow: true })).toBe("start");
    expect(decideMenuRetry({ quitting: false, hasWindow: false })).toBe("open-window");
  });
});
