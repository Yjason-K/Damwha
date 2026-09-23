import { describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../../src/update/release-check";
import type { NewerChoice } from "../../src/update/dialogs";
import { createUpdateFlow, type UpdateFlowDeps } from "../../src/update/update-flow";

const URL_040 = "https://github.com/Yjason-K/Damwha/releases/tag/v0.4.0";
const newer = (version = "0.4.0"): CheckResult => ({
  kind: "newer",
  version,
  url: `https://github.com/Yjason-K/Damwha/releases/tag/v${version}`,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(over: Partial<UpdateFlowDeps> = {}) {
  const log: string[] = [];
  const opened: string[] = [];
  const infos: unknown[] = [];
  const state = { skipped: null as string | null, answer: "later" as NewerChoice, now: 0 };
  const deps: UpdateFlowDeps = {
    check: vi.fn(async () => newer()),
    now: () => state.now,
    isAttached: () => true,
    isRecording: async () => false,
    isShuttingDown: () => false,
    isOtherModalOpen: () => false,
    loadSkipped: () => state.skipped,
    saveSkipped: (v) => {
      state.skipped = v;
    },
    showNewer: vi.fn(async () => state.answer),
    showInfo: vi.fn(async (i) => {
      infos.push(i);
    }),
    openExternal: vi.fn(async (u: string) => {
      opened.push(u);
    }),
    log: (l) => log.push(l),
    ...over,
  };
  return { deps, flow: createUpdateFlow(deps, "0.3.1"), log, opened, infos, state };
}

describe("autoCheck — 표시", () => {
  it("새 버전이면 대화상자를 띄우고 열기를 누르면 페이지를 연다", async () => {
    const h = harness();
    h.state.answer = "open";
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledWith({ current: "0.3.1", latest: "0.4.0" });
    expect(h.opened).toEqual([URL_040]);
  });

  it("같은 버전은 실행당 한 번만 묻는다", async () => {
    const h = harness();
    await h.flow.autoCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("더 새 버전이 나오면 다시 묻는다", async () => {
    const results = [newer("0.4.0"), newer("0.5.0")];
    const h = harness({ check: vi.fn(async () => results.shift()!) });
    await h.flow.autoCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(2);
  });

  it("건너뛰기를 저장하고 그 버전은 자동으로 다시 묻지 않는다", async () => {
    const h = harness();
    h.state.answer = "skip";
    await h.flow.autoCheck();
    expect(h.state.skipped).toBe("0.4.0");
    const h2 = harness();
    h2.state.skipped = "0.4.0";
    await h2.flow.autoCheck();
    expect(h2.deps.showNewer).not.toHaveBeenCalled();
  });

  it("current면 화면 없이 로그 한 줄", async () => {
    const h = harness({ check: async () => ({ kind: "current", latest: "0.3.1" }) });
    await h.flow.autoCheck();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
    expect(h.deps.showInfo).not.toHaveBeenCalled();
    expect(h.log).toEqual(["업데이트 확인: 최신 (0.3.1)"]);
  });

  it("실패는 화면 없이 로그 한 줄", async () => {
    const h = harness({ check: async () => ({ kind: "failed", reason: "offline", detail: "x" }) });
    await h.flow.autoCheck();
    expect(h.deps.showInfo).not.toHaveBeenCalled();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
    expect(h.log.join("\n")).toContain("업데이트 확인 실패 (offline)");
  });
});

describe("autoCheck — 보류", () => {
  const cases: [string, Partial<UpdateFlowDeps>][] = [
    ["미부착", { isAttached: () => false }],
    ["다른 모달", { isOtherModalOpen: () => true }],
    ["종료 중", { isShuttingDown: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) }],
    ["녹음 중", { isRecording: async () => true }],
  ];
  for (const [name, over] of cases) {
    it(`${name}이면 띄우지 않고 로그를 남기며, 다음 확인에서 띄운다`, async () => {
      const h = harness(over);
      await h.flow.autoCheck();
      expect(h.deps.showNewer).not.toHaveBeenCalled();
      expect(h.log.join("\n")).toContain("업데이트 알림 보류");
      Object.assign(h.deps, {
        isAttached: () => true,
        isOtherModalOpen: () => false,
        isShuttingDown: () => false,
        isRecording: async () => false,
      });
      await h.flow.autoCheck();
      expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
    });
  }

  it("녹음 질문 뒤 창이 사라졌으면 띄우지 않는다", async () => {
    const attached = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const h = harness({ isAttached: attached });
    await h.flow.autoCheck();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
  });

  it("녹음 질문이 거부되면 녹음 중으로 보고 보류한다", async () => {
    const h = harness({ isRecording: async () => Promise.reject(new Error("x")) });
    await h.flow.autoCheck();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
  });

  it("종료가 확정된 뒤에는 조회도 하지 않는다", async () => {
    const h = harness({ isShuttingDown: () => true });
    await h.flow.autoCheck();
    expect(h.deps.check).not.toHaveBeenCalled();
  });
});

describe("manualCheck", () => {
  it("건너뛴 버전·녹음·미부착을 무시하고 띄운다", async () => {
    const h = harness({ isAttached: () => false, isRecording: async () => true });
    h.state.skipped = "0.4.0";
    await h.flow.manualCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("자동으로 이미 보인 버전도 다시 보인다", async () => {
    const h = harness();
    await h.flow.autoCheck();
    await h.flow.manualCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(2);
  });

  it("최신·실패를 말한다", async () => {
    const h1 = harness({ check: async () => ({ kind: "current", latest: "0.3.1" }) });
    await h1.flow.manualCheck();
    expect(h1.infos).toEqual([{ kind: "current", current: "0.3.1" }]);
    const h2 = harness({ check: async () => ({ kind: "failed", reason: "offline", detail: "x" }) });
    await h2.flow.manualCheck();
    expect(h2.infos).toEqual([{ kind: "failed", detail: "인터넷에 연결되어 있지 않은 것 같아요." }]);
  });

  it("종료 중이면 아무것도 하지 않는다", async () => {
    const h = harness({ isShuttingDown: () => true });
    await h.flow.manualCheck();
    expect(h.deps.check).not.toHaveBeenCalled();
    expect(h.deps.showInfo).not.toHaveBeenCalled();
  });

  it("수동에서 보인 버전은 자동이 다시 묻지 않는다", async () => {
    const h = harness();
    await h.flow.manualCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });
});

describe("조회 공유와 표시 잠금", () => {
  it("동시에 들어온 자동·수동은 조회를 한 번만 하고 한 번만 띄운다", async () => {
    const d = deferred<CheckResult>();
    const h = harness({ check: vi.fn(() => d.promise) });
    const a = h.flow.autoCheck();
    const m = h.flow.manualCheck();
    d.resolve(newer());
    await Promise.all([a, m]);
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("녹음 답이 엇갈려 온 두 자동 확인이 같은 버전을 두 번 띄우지 않는다", async () => {
    const answers = [deferred<boolean>(), deferred<boolean>()];
    const pending = [...answers];
    const h = harness({ isRecording: vi.fn(() => pending.shift()!.promise) });
    const a1 = h.flow.autoCheck();
    const a2 = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.isRecording).toHaveBeenCalledTimes(2));
    answers[0].resolve(false);
    await a1;
    answers[1].resolve(false);
    await a2;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
    expect(h.log.join("\n")).toContain("업데이트 알림 버림: 이미 처리됨 (0.4.0)");
  });

  it("자동이 녹음 답을 기다리는 사이 수동이 띄웠으면 자동은 다시 띄우지 않는다", async () => {
    const rec = deferred<boolean>();
    const h = harness({ isRecording: vi.fn(() => rec.promise) });
    const a = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.isRecording).toHaveBeenCalledTimes(1));
    await h.flow.manualCheck();
    rec.resolve(false);
    await a;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("수동 연타는 두 번째를 무시한다", async () => {
    const d = deferred<CheckResult>();
    const h = harness({ check: vi.fn(() => d.promise) });
    const m1 = h.flow.manualCheck();
    const m2 = h.flow.manualCheck();
    d.resolve({ kind: "current", latest: "0.3.1" });
    await Promise.all([m1, m2]);
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    expect(h.deps.showInfo).toHaveBeenCalledTimes(1);
  });

  it("자동 대화상자가 떠 있는 동안의 수동 클릭은 무시한다", async () => {
    const shown = deferred<NewerChoice>();
    const h = harness({ showNewer: vi.fn(() => shown.promise) });
    const a = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.showNewer).toHaveBeenCalledTimes(1));
    await h.flow.manualCheck();
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    shown.resolve("later");
    await a;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("대화상자가 떠 있는 동안의 자동 확인은 결과를 버린다", async () => {
    const results = [newer("0.4.0"), newer("0.5.0")];
    const shown = deferred<NewerChoice>();
    const h = harness({ check: vi.fn(async () => results.shift()!), showNewer: vi.fn(() => shown.promise) });
    const a1 = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.showNewer).toHaveBeenCalledTimes(1));
    await h.flow.autoCheck();
    shown.resolve("later");
    await a1;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("수동 정보 대화상자가 떠 있는 동안의 자동 확인은 버린다", async () => {
    const info = deferred<void>();
    const results: CheckResult[] = [{ kind: "current", latest: "0.3.1" }, newer()];
    const h = harness({ check: vi.fn(async () => results.shift()!), showInfo: vi.fn(() => info.promise) });
    const m = h.flow.manualCheck();
    await vi.waitFor(() => expect(h.deps.showInfo).toHaveBeenCalledTimes(1));
    await h.flow.autoCheck();
    info.resolve();
    await m;
    expect(h.deps.showNewer).not.toHaveBeenCalled();
  });

  it("대화상자가 떠 있는 사이 종료가 시작되면 선택을 버린다", async () => {
    let shutting = false;
    const h = harness({
      isShuttingDown: () => shutting,
      showNewer: vi.fn(async () => {
        shutting = true;
        return "skip" as const;
      }),
    });
    await h.flow.autoCheck();
    expect(h.state.skipped).toBeNull();
    expect(h.opened).toEqual([]);
  });

  it("대화상자·브라우저 열기가 실패해도 잠금이 풀린다", async () => {
    const h = harness({
      showNewer: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("open"),
      openExternal: vi.fn().mockRejectedValueOnce(new Error("no browser")).mockResolvedValue(undefined),
    });
    await h.flow.manualCheck();
    await h.flow.manualCheck();
    await h.flow.manualCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(3);
    expect(h.log.join("\n")).toContain("boom");
    expect(h.log.join("\n")).toContain("no browser");
  });
});

describe("자동 대화상자 실패", () => {
  it("자동 대화상자가 실패해도 잠금이 풀려 다음 자동 확인이 띄운다", async () => {
    const results = [newer("0.4.0"), newer("0.5.0")];
    const h = harness({
      check: vi.fn(async () => results.shift()!),
      showNewer: vi.fn().mockRejectedValueOnce(new Error("sheet")).mockResolvedValue("later"),
    });
    await h.flow.autoCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(2);
    expect(h.log.join("\n")).toContain("sheet");
  });
});

describe("한도 쿨다운", () => {
  it("rate_limited 뒤에는 만료까지 요청하지 않고, 만료 뒤 다시 요청한다", async () => {
    const results: CheckResult[] = [
      { kind: "failed", reason: "rate_limited", detail: "HTTP 403", retryAfterMs: 60_000 },
      { kind: "current", latest: "0.3.1" },
    ];
    const h = harness({ check: vi.fn(async () => results.shift()!) });
    await h.flow.manualCheck();
    h.state.now = 1_000;
    await h.flow.manualCheck();
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    expect(h.infos[1]).toEqual({ kind: "failed", detail: "확인 요청이 너무 많았어요. 1분 뒤에 다시 시도할 수 있어요." });
    h.state.now = 61_000;
    await h.flow.manualCheck();
    expect(h.deps.check).toHaveBeenCalledTimes(2);
  });
});
