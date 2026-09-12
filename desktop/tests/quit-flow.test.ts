import { describe, expect, it } from "vitest";
import { graceExpiryPrompt, leftoverNotice, runQuitFlow, type QuitFlowDeps } from "../src/quit-flow";
import { STOP_DETAIL } from "../src/shutdown";

/**
 * 잎만 가짜다. 판정 대상인 **순서**는 진짜 코드가 정한다.
 *
 * 가짜가 비동기이고 들어간 것과 나온 것을 따로 적는 것이 이 파일의 판정 절반이다 —
 * window-flow.test.ts가 실측으로 확인한 대로, 동기 가짜는 `await`를 지우는 변이에도
 * 같은 순서를 기록해 어설션이 하나도 깨지지 않는다. 프로덕션에서 그 편집이 내는 것은
 * 순서 뒤바뀜이 아니라 **겹침**이다: 핸드셰이크가 끝나기 전에 API가 내려가면 렌더러의
 * 마지막 청크가 갈 곳이 없고, 그것을 봉인할 sweeper도 방금 같이 죽는다 (P2-C13).
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const seq = (...names: string[]) => names.flatMap((n) => [`${n}:start`, `${n}:end`]);

function recorder(
  over: Partial<QuitFlowDeps> = {},
  state: { recording: boolean; analysing: boolean } = { recording: false, analysing: false },
) {
  const log: string[] = [];
  const lines: string[] = [];
  const warned: Array<{ message: string; detail: string; kind: string }> = [];
  const asked: string[] = [];
  const mark = <T>(what: string, value: T) => async () => {
    log.push(`${what}:start`);
    await tick();
    log.push(`${what}:end`);
    return value;
  };
  const deps: QuitFlowDeps = {
    inFlight: mark("inFlight", state),
    confirm: async (message: string) => {
      asked.push(message);
      log.push("confirm:start");
      await tick();
      log.push("confirm:end");
      return true;
    },
    captureDescendants: mark("capture", undefined),
    beginQuit: () => log.push("begin"),
    stopRecording: mark("handshake", { stopped: true }),
    handshakeTimeoutMs: 50,
    stopServices: mark("stop", { stopped: true, leaked: [] }),
    log: (line) => lines.push(line),
    warn: async (notice) => {
      warned.push(notice);
      log.push("warn:start");
      await tick();
      log.push("warn:end");
    },
    quit: () => log.push("quit"),
    ...over,
  };
  return { log, lines, warned, asked, deps };
}

describe("runQuitFlow", () => {
  it("quits without asking when nothing is in flight", async () => {
    const { log, asked, deps } = recorder();
    await runQuitFlow(deps);
    expect(asked).toEqual([]);
    expect(log).toEqual([...seq("capture", "inFlight"), "begin", ...seq("capture", "stop"), "quit"]);
  });

  it("snapshots the worker's descendants BEFORE the confirmation dialog", async () => {
    // 확인 대화상자는 시간 상한이 없다. 그 뒤에만 찍으면, 사람이 답하는 동안 supervisor가
    // 죽었을 때 그 자손은 이미 pid 1로 재부모화돼 영영 보이지 않는다 (이월 결함 N2).
    const { log, deps } = recorder({}, { recording: false, analysing: true });
    await runQuitFlow(deps);
    expect(log.indexOf("capture:end")).toBeLessThan(log.indexOf("confirm:start"));
  });

  it("snapshots again right before the services go down", async () => {
    // 두 번째가 가장 새것이라 pid 재사용 위험이 가장 작다. 이 자리를 놓치면 대화상자
    // 동안 새로 뜬 --once 자식을 통째로 못 본다.
    const { log, deps } = recorder();
    await runQuitFlow(deps);
    const stop = log.indexOf("stop:start");
    const capturesBeforeStop = log.filter((l, i) => l === "capture:end" && i < stop);
    expect(capturesBeforeStop).toHaveLength(2);
  });

  it("does not quit, stop anything, or latch when the user cancels", async () => {
    const { log, deps } = recorder({ confirm: async () => false }, { recording: true, analysing: false });
    await runQuitFlow(deps);
    expect(log).not.toContain("begin");
    expect(log).not.toContain("stop:start");
    expect(log).not.toContain("quit");
  });

  it("finishes the renderer handshake BEFORE any service is stopped", async () => {
    // 창이 먼저 죽으면 마지막 청크를 잃고, 그것을 봉인하는 sweeper는 API의 @Cron이라
    // 우리가 API도 내리는 이 경로에서는 아무도 봉인하지 않는다 → producer_abandoned.
    const { log, deps } = recorder({}, { recording: true, analysing: false });
    await runQuitFlow(deps);
    expect(log).toEqual([
      ...seq("capture", "inFlight", "confirm"),
      "begin",
      ...seq("handshake", "capture", "stop"),
      "quit",
    ]);
  });

  it("asks only once when a recording and an analysis are both in flight", async () => {
    const { asked, deps } = recorder({}, { recording: true, analysing: true });
    await runQuitFlow(deps);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("녹음");
    expect(asked[0]).toContain("분석");
  });

  it("does not run the handshake when only an analysis is in flight", async () => {
    const { log, deps } = recorder({}, { recording: false, analysing: true });
    await runQuitFlow(deps);
    expect(log).not.toContain("handshake:start");
    expect(log).toContain("quit");
  });

  it("still quits when the renderer refuses to stop, and says so in the log", async () => {
    // 막으면 사용자가 앱을 끌 수 없다. 다음 실행 때 API가 뜨면 sweeper가 마감한다.
    const { log, lines, deps } = recorder(
      { stopRecording: async () => ({ stopped: false, reason: "창이 이미 없어요" }) },
      { recording: true, analysing: false },
    );
    await runQuitFlow(deps);
    expect(log).toContain("stop:start");
    expect(log[log.length - 1]).toBe("quit");
    expect(lines.join("\n")).toContain("failed");
  });

  it("still quits when the renderer never answers at all", async () => {
    // 훅이 걸려 영원히 안 끝나는 경우. 상한이 없으면 앱이 종료 도중에 굳는다.
    const { log, lines, deps } = recorder(
      { stopRecording: () => new Promise(() => undefined), handshakeTimeoutMs: 20 },
      { recording: true, analysing: false },
    );
    await runQuitFlow(deps);
    expect(log[log.length - 1]).toBe("quit");
    expect(lines.join("\n")).toContain("timeout");
  });

  it("warns when a stop could not be verified even though no pid is named", async () => {
    // 스펙 §6.9: `{stopped:false, leaked:[]}`는 "남은 것 없음"과 **구별해** 표시해야 한다.
    // leaked.length > 0으로 거르면 이 상태가 화면에서 통째로 사라진다.
    const { log, warned, deps } = recorder({
      stopServices: async () => ({
        stopped: false,
        leaked: [],
        detail: STOP_DETAIL.unverifiable,
      }),
    });
    await runQuitFlow(deps);
    expect(warned).toHaveLength(1);
    expect(warned[0].detail).toContain(STOP_DETAIL.unverifiable);
    expect(log[log.length - 1]).toBe("quit");
  });

  it("says nothing when the stop was clean", async () => {
    const { warned, lines, deps } = recorder();
    await runQuitFlow(deps);
    expect(warned).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("writes the leftover to the log as well as the screen", async () => {
    // 정리 실패를 조용히 넘기지 않는다 (스펙 §6.9 5단계). 대화상자는 닫히면 사라진다.
    const { lines, deps } = recorder({
      stopServices: async () => ({ stopped: false, leaked: [321], detail: STOP_DETAIL.orphans }),
    });
    await runQuitFlow(deps);
    expect(lines.join("\n")).toContain("321");
  });

  it("quits even when stopping the services throws", async () => {
    // before-quit이 preventDefault로 이번 종료를 막았다. quit()이 한 번이라도 사라지면
    // 앱은 창도 없이 남아 다시는 끝나지 않는다 (Phase 1이 값을 치른 자리다).
    const boom = new Error("감독자가 터졌다");
    const { log, deps } = recorder({
      stopServices: async () => {
        throw boom;
      },
    });
    await expect(runQuitFlow(deps)).rejects.toBe(boom);
    expect(log).toContain("quit");
  });

  it("quits even when the leftover dialog itself fails", async () => {
    const { log, deps } = recorder({
      stopServices: async () => ({ stopped: false, leaked: [9], detail: STOP_DETAIL.orphans }),
      warn: async () => {
        throw new Error("대화상자를 띄울 창이 없다");
      },
    });
    await expect(runQuitFlow(deps)).rejects.toThrow();
    expect(log).toContain("quit");
  });
});

describe("graceExpiryPrompt", () => {
  it("tells someone whose analysis is progressing that it is progressing", async () => {
    // 31분 오디오의 STT 한가운데는 분 단위로 걸린다. 그 사람의 올바른 선택은 기다리는
    // 것인데, 한 문구로 합쳐 두면 "응답하지 않습니다"가 강제 종료를 권하게 된다.
    const p = graceExpiryPrompt(true);
    expect(p.message).toContain("마무리");
    expect(p.message).not.toContain("응답하지");
    expect(p.detail).toContain("다시 큐에");
  });

  it("does not tell someone whose worker is wedged that it is making progress", async () => {
    const p = graceExpiryPrompt(false);
    expect(p.message).toContain("응답하지");
    expect(p.message).not.toContain("마무리");
  });
});

describe("leftoverNotice", () => {
  it("words a live orphan as something still running", () => {
    const n = leftoverNotice({ stopped: false, leaked: [11, 12], detail: STOP_DETAIL.orphans });
    expect(n.kind).toBe("warning");
    expect(n.message).toContain("살아 있을 수 있는");
    expect(n.detail).toContain(STOP_DETAIL.orphans);
    expect(n.detail).toContain("11, 12");
    // 스펙 §6.9 — 남은 pid는 후보이지 증거가 아니다. 그대로 죽이라고 시키지 않는다.
    expect(n.detail).toContain("후보이지 증거가 아니");
  });

  it("words an unprovable stop as unprovable, not as 'nothing left'", () => {
    const n = leftoverNotice({ stopped: false, leaked: [], detail: STOP_DETAIL.unverifiable });
    expect(n.kind).toBe("warning");
    expect(n.message).toContain("확인하지 못했");
    expect(n.detail).toContain(STOP_DETAIL.unverifiable);
    expect(n.detail).toContain("특정하지 못했");
  });

  it("does not call the user's own choice a failure", () => {
    // "계속 기다리기"를 고른 사람에게 정리 실패라고 적고 경고 아이콘까지 달면, 방금 고른
    // 것을 오류라고 말하는 셈이다. 이 구분이 detail 필드가 존재하는 이유다.
    const n = leftoverNotice({ stopped: false, leaked: [4242], detail: STOP_DETAIL.declined });
    expect(n.kind).toBe("info");
    expect(n.message).toContain("마무리");
    expect(n.detail).toContain("스스로 끝납니다");
    expect(n.detail).not.toContain(STOP_DETAIL.orphans);
  });

  it("still reads the user's choice after the supervisor joined several reasons", () => {
    // stopAll이 서비스별 사유를 줄바꿈으로 이어 붙인다. 같은지 비교하면 두 번째 사유가
    // 붙는 순간 이 갈래가 조용히 죽어, 사용자가 고른 결과가 다시 경고로 뜬다.
    const n = leftoverNotice({
      stopped: false,
      leaked: [4242],
      detail: `${STOP_DETAIL.declined}\napi: 종료 중 예외 — boom`,
    });
    expect(n.kind).toBe("info");
  });

  it("falls back to 'could not verify' when no reason came back at all", () => {
    const n = leftoverNotice({ stopped: false, leaked: [] });
    expect(n.detail).toContain(STOP_DETAIL.unverifiable);
  });
});
