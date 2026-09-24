import { describe, expect, it } from "vitest";
import { reapBeforeStart, systemReapDeps } from "../../src/app/reap-on-start";
import { mayAutoRetry } from "../../src/app/retry-policy";
import { CAUSES } from "../../src/diagnostics/causes";
import { recoveryOf, ServiceFailure } from "../../src/services/failure";
import type { KnownTree, ReapDeps } from "../../src/process/orphans";
import { HINTS } from "../../src/windows/shell-hints";
import { failureDetail } from "../../src/windows/status-view";

const ROOT = "/Users/me/daewha/desktop/build/python";
const TREES: readonly KnownTree[] = [{ root: ROOT, python: `${ROOT}/bin/python3.12` }];
const OLD = "desktop-22222222-2222-4222-8222-222222222222";

function deps(ps: () => Promise<string>): { d: ReapDeps; killed: number[] } {
  const killed: number[] = [];
  const alive = new Set([1, 4001]);
  return {
    killed,
    d: {
      runId: "desktop-11111111-1111-4111-8111-111111111111",
      trees: TREES,
      ps,
      descendantsOf: async () => [],
      kill: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      exists: (pid) => alive.has(pid),
      log: () => undefined,
    },
  };
}

/**
 * P4-C22 — 스캔 러너에 `ps` 비영 종료와 빈 출력을 각각 주입한다. 기동 중단은 이 함수가 던지는 것이고,
 * main.ts의 createSupervisorFor가 어떤 서비스보다 먼저 이것을 await한다. 화면의 원인과 안내는
 * startOnce → reportFailure가 쓰는 조립(failureDetail·mayAutoRetry)을 그대로 불러 확인한다.
 */
describe("reapBeforeStart — 스캔이 실패하면 기동하지 않는다", () => {
  const failures: Array<[string, () => Promise<string>]> = [
    ["ps exits non-zero", async () => Promise.reject(Object.assign(new Error("Command failed: /bin/ps"), { code: 1 }))],
    ["ps prints nothing", async () => ""],
  ];

  it.each(failures)("%s → a manual failure naming the cause, no signal sent", async (_name, ps) => {
    const { d, killed } = deps(ps);
    const err = await reapBeforeStart(d).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceFailure);
    expect(recoveryOf(err)).toBe("manual");
    expect((err as Error).message).toBe(CAUSES.orphanScanFailed.text);
    expect(killed).toEqual([]);
    // 자동 재시도 루프를 걸지 않는다 (판정 R-7b) — 메뉴의 "다시 시도"가 스캔을 다시 돈다.
    expect(mayAutoRetry(null, err)).toBe(false);
    // 실패 화면은 원인과 "다시 시도" 안내를 함께 싣는다 (스펙 §8).
    const screen = failureDetail("앱을 시작하지 못했어요", (err as Error).message);
    expect(screen).toContain(CAUSES.orphanScanFailed.text);
    expect(screen).toContain(HINTS.orphanScanFailed as string);
    expect(HINTS.orphanScanFailed).toMatch(/다시 시도/);
  });

  it("resolves with what it reaped when the scan works", async () => {
    const { d, killed } = deps(async () => `  PID ARGS\n    1 /sbin/launchd\n 4001 ${ROOT}/bin/python3.12 -m damwha_worker --run-id=${OLD}`);
    await expect(reapBeforeStart(d)).resolves.toEqual([4001]);
    expect(killed).toEqual([4001]);
  });

  it("refuses to start when an orphan survives the reap (writersAlive)", async () => {
    const line = `  PID ARGS\n    1 /sbin/launchd\n 4001 ${ROOT}/bin/python3.12 -m damwha_worker --run-id=${OLD}`;
    const { d } = deps(async () => line);
    // SIGKILL이 닿지 않은 경우(EPERM) — 던지고, 프로세스는 남는다.
    d.kill = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    await expect(reapBeforeStart(d)).rejects.toMatchObject({
      recovery: "manual",
      message: expect.stringMatching(/이전 실행의 처리 프로세스가 아직 남아 있어요 \(pid 4001\)/),
    });
  });
});

describe("systemReapDeps", () => {
  it("wires the polite first signal and the grace wait, and answers existence from the kernel", () => {
    const d = systemReapDeps({ runId: "desktop-x", trees: TREES, log: () => undefined });
    expect(d.runId).toBe("desktop-x");
    expect(d.trees).toBe(TREES);
    expect(typeof d.terminate).toBe("function");
    expect(typeof d.sleep).toBe("function");
    expect(d.exists(process.pid)).toBe(true);
    // macOS의 pid는 99999를 넘지 않는다.
    expect(d.exists(99_999_999)).toBe(false);
  });

  it("lets a refused signal surface as a throw, so the reaper does not count it", () => {
    const d = systemReapDeps({ runId: "desktop-x", trees: TREES, log: () => undefined });
    expect(() => d.kill(99_999_999)).toThrow();
    expect(() => d.terminate!(99_999_999)).toThrow();
  });
});
