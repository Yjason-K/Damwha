import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  CLOSE_WHILE_RECORDING,
  HANDSHAKE_TIMEOUT_MS,
  createFlowLatch,
  decideCloseEvent,
  decideQuitEvent,
  graceExpiryPrompt,
  leftoverNotice,
  runCloseFlow,
  runQuitFlow,
  type CloseFlowDeps,
  type QuitFlowDeps,
} from "../../src/app/quit-flow";
import { STOP_DETAIL } from "../../src/services/worker-shutdown";

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
  const warned: Array<{ message: string; detail: string }> = [];
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
    showQuitting: mark("quitting", undefined),
    // tsconfig의 include는 src/**만이라 **테스트는 타입 검사를 받지 않는다.** 이 필드를 빼면
    // screenTimeoutMs가 undefined가 되고 setTimeout(fn, undefined)은 0ms라, 상한이 매번
    // 이겨서 화면을 기다리는 코드가 통째로 안 돌면서도 초록불이 난다.
    screenTimeoutMs: 50,
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
    expect(log).toEqual([
      ...seq("capture", "inFlight"),
      "begin",
      ...seq("quitting", "capture", "stop"),
      "quit",
    ]);
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

  it("puts a screen up before the worker grace when there is no handshake to run", async () => {
    // 녹음이 없으면 앞에 남은 긴 기다림은 worker 유예 90초뿐이고, 파괴할 렌더러 훅도 없다.
    // 그동안 화면이 그대로면 ⌘Q를 누른 사람은 앱이 멎었다고 결론 내리고 강제 종료를 누른다
    // — 정중한 경로가 존재하는 이유를 침묵이 무효로 만든다 (완료 기준 P2-C5).
    const { log, deps } = recorder({}, { recording: false, analysing: true });
    await runQuitFlow(deps);
    expect(log).not.toContain("handshake:start");
    // indexOf만 비교하면 화면이 **통째로 사라져도** 통과한다 — 없는 값의 indexOf는 -1이고
    // -1 < 무엇이든 참이다. 이 갈래를 위해 쓰인 테스트가 이 갈래를 지키지 못했다.
    expect(log).toContain("quitting:end");
    expect(log.indexOf("quitting:end")).toBeLessThan(log.indexOf("stop:start"));
  });

  it("runs the handshake BEFORE the screen that would destroy the renderer", async () => {
    // 이 화면의 잎은 창이 하나뿐인 앱에서 win.loadFile(status.html) — 그 창의 내비게이션이라
    // 렌더러의 window.__damwha_desktop을 문서째 파괴한다. 화면이 먼저 뜨면 핸드셰이크는
    // 언제나 no-bridge를 받고 tail 청크를 잃는다 → capture_error = producer_abandoned
    // (완료 기준 P2-C13). §6.9: "종료 순서의 맨 앞에 handshake를 둔다."
    //
    // 그래도 화면은 stopServices(worker 유예 90초) **앞**에 온다 — P2-C5의 침묵은 그
    // 90초가 만들고, 그 앞자리는 이 순서로도 그대로 지켜진다.
    const { log, deps } = recorder({}, { recording: true, analysing: false });
    await runQuitFlow(deps);
    expect(log.indexOf("handshake:end")).toBeLessThan(log.indexOf("quitting:start"));
    expect(log.indexOf("quitting:end")).toBeLessThan(log.indexOf("stop:start"));
  });

  it("does not put that screen up before the user has agreed to quit", async () => {
    const { log, deps } = recorder({ confirm: async () => false }, { recording: true, analysing: false });
    await runQuitFlow(deps);
    expect(log).not.toContain("quitting:start");
  });

  it("quits even when the quitting screen cannot be shown", async () => {
    // 창이 파괴되는 중이면 loadFile이 거부한다. 그걸로 종료를 멈추면 앱이 영영 안 꺼진다.
    const { log, lines, deps } = recorder({
      showQuitting: async () => {
        throw new Error("창이 이미 없어요");
      },
    });
    await runQuitFlow(deps);
    expect(log).toContain("stop:start");
    expect(log[log.length - 1]).toBe("quit");
    expect(lines.join("\n")).toContain("창이 이미 없어요");
  });

  it("quits even when the renderer never commits the quitting screen", async () => {
    // 이 잎은 win.loadFile — **렌더러가 커밋해야** 끝나는 프라미스다. 봉쇄된 렌더러(무한 JS
    // 루프)에서는 거부하지도 해결하지도 않는다. beginQuit()과 finally의 quit() 사이에 상한
    // 없는 대기가 하나라도 있으면 그 순간 앱을 끌 길이 사라진다 — before-quit이 이미
    // preventDefault를 불렀기 때문이다. "봉쇄된 렌더러가 종료나 닫힘을 막는 일은 없어야
    // 한다"는 판정이 이 자리에도 적용된다 (재리뷰 2의 N2).
    const { log, lines, deps } = recorder({
      showQuitting: () => new Promise<void>(() => undefined),
      screenTimeoutMs: 20,
    });
    await runQuitFlow(deps);
    // 화면 뒤의 것들이 전부 돌았다. 상한이 없으면 여기까지 오지 못한다(테스트가 멎는다).
    expect(log).toContain("stop:start");
    expect(log[log.length - 1]).toBe("quit");
    // 조용히 지나가지 않는다. 로그가 없으면 Task 15의 수동 점검이 이것을 관측할 수 없다.
    expect(lines.join("\n")).toContain("종료 화면이 20ms 안에 뜨지 않았어요");
  });

  it("still reports a screen that actually failed, instead of only the deadline", async () => {
    // 상한을 걸면서 거부를 삼키면, 창이 파괴되는 중이라 loadFile이 거부한 경우까지 "시간
    // 초과"로 뭉개진다. 원인이 다르면 로그도 달라야 한다 — 이 줄이 Task 15의 수동 점검에서
    // 두 경우를 가르는 유일한 단서다.
    const { lines, deps } = recorder({
      showQuitting: async () => {
        throw new Error("창이 이미 없어요");
      },
      screenTimeoutMs: 5_000,
    });
    await runQuitFlow(deps);
    expect(lines.join("\n")).toContain("종료 화면을 걸지 못했어요 — 창이 이미 없어요");
    expect(lines.join("\n")).not.toContain("안 뜨지 않았어요");
  });

  it("does not quit, stop anything, or latch when the user cancels", async () => {
    const { log, deps } = recorder({ confirm: async () => false }, { recording: true, analysing: false });
    await runQuitFlow(deps);
    expect(log).not.toContain("begin");
    expect(log).not.toContain("stop:start");
    expect(log).not.toContain("quit");
  });

  // ── 묻지도 못했을 때 (최종 리뷰 I-2) ────────────────────────────────────────────
  // 확인 전에 거부가 나면 흐름이 스냅샷 한 장만 찍고 거부했고, main.ts의 catch는 app.quit()만
  // 불렀다 — worker·embed가 정지 신호 한 번 없이 남고 사람에게는 아무 말도 없었다(P2-C4).
  // 정한 답: 실패가 종료를 막지 않고 자식도 남기지 않도록 **정상 종료 경로를 그대로 탄다.**
  const rejectingAfterTick = (what: string, log: string[]) => async () => {
    log.push(`${what}:start`);
    await tick();
    throw new Error("Object has been destroyed");
  };

  it("stops every service before quitting when the confirmation dialog itself fails", async () => {
    const r = recorder({}, { recording: true, analysing: true });
    r.deps.confirm = rejectingAfterTick("confirm", r.log);
    // 흐름이 거부하지 않는다 — 거부하면 main.ts의 catch가 서비스를 내리지 않고 끝낸다.
    await expect(runQuitFlow(r.deps)).resolves.toBeUndefined();
    // 알던 대로 녹음 중이었으므로 핸드셰이크가 먼저, 그 뒤 화면·2차 스냅샷·서비스 정지, 마지막에 quit.
    expect(r.log).toEqual([
      ...seq("capture", "inFlight"),
      "confirm:start",
      "begin",
      ...seq("handshake", "quitting", "capture", "stop"),
      "quit",
    ]);
    // 조용히 넘기지 않는다 — Task 15의 수동 점검이 이 줄로 이 경로를 관측한다.
    expect(r.lines.join("\n")).toContain("종료 확인을 묻지 못했어요 (Object has been destroyed)");
  });

  it("uses what it did learn: no handshake when only the dialog failed and nothing was recording", async () => {
    // 모르는 것만 "녹음 중"으로 본다. 아는 답(녹음 아님)을 버리고 핸드셰이크를 돌리면 녹음이 없는
    // 창에 중지를 부르고 "정상 중지하지 못했어요"라는 거짓 로그를 남긴다.
    const r = recorder({}, { recording: false, analysing: true });
    r.deps.confirm = rejectingAfterTick("confirm", r.log);
    await runQuitFlow(r.deps);
    expect(r.log).toEqual([
      ...seq("capture", "inFlight"),
      "confirm:start",
      "begin",
      ...seq("quitting", "capture", "stop"),
      "quit",
    ]);
  });

  it("finishes a possible recording and stops every service when it could not even learn what is in flight", async () => {
    // 녹음 여부를 모른다. "아니오"로 닫으면 녹음 중이던 창의 tail 청크를 조용히 잃는다(P2-C13) —
    // 핸드셰이크에는 자기 상한이 있고, 녹음이 없으면 no-bridge로 끝날 뿐이다.
    const r = recorder();
    r.deps.inFlight = rejectingAfterTick("inFlight", r.log) as QuitFlowDeps["inFlight"];
    await expect(runQuitFlow(r.deps)).resolves.toBeUndefined();
    expect(r.asked).toEqual([]);
    expect(r.log).toEqual([
      ...seq("capture"),
      "inFlight:start",
      "begin",
      ...seq("handshake", "quitting", "capture", "stop"),
      "quit",
    ]);
  });

  it("neither skips the question nor the service stop when a descendant snapshot fails", async () => {
    // 두 스냅샷 모두 거부한다. 첫째가 새면 확인 없이 끝나고, 둘째가 새면 stopServices를 건너뛴 채
    // finally의 quit()으로 떨어진다 — 둘 다 자식을 남긴다.
    const r = recorder({}, { recording: false, analysing: true });
    r.deps.captureDescendants = rejectingAfterTick("capture", r.log) as QuitFlowDeps["captureDescendants"];
    await expect(runQuitFlow(r.deps)).resolves.toBeUndefined();
    expect(r.log).toEqual([
      "capture:start",
      ...seq("inFlight", "confirm"),
      "begin",
      "quitting:start",
      "quitting:end",
      "capture:start",
      ...seq("stop"),
      "quit",
    ]);
    expect(r.lines.join("\n")).toContain("종료 전 자손 스냅샷이 실패했어요 — Object has been destroyed");
  });

  it("finishes the renderer handshake BEFORE any service is stopped", async () => {
    // 창이 먼저 죽으면 마지막 청크를 잃고, 그것을 봉인하는 sweeper는 API의 @Cron이라
    // 우리가 API도 내리는 이 경로에서는 아무도 봉인하지 않는다 → producer_abandoned.
    const { log, deps } = recorder({}, { recording: true, analysing: false });
    await runQuitFlow(deps);
    expect(log).toEqual([
      ...seq("capture", "inFlight", "confirm"),
      "begin",
      ...seq("handshake", "quitting", "capture", "stop"),
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
    expect(n.message).toContain("살아 있을 수 있는");
    expect(n.detail).toContain(STOP_DETAIL.orphans);
    expect(n.detail).toContain("11, 12");
    // 스펙 §6.9 — 남은 pid는 후보이지 증거가 아니다. 그대로 죽이라고 시키지 않는다.
    expect(n.detail).toContain("후보이지 증거가 아니");
  });

  it("words an unprovable stop as unprovable, not as 'nothing left'", () => {
    // 스펙 §6.9가 "종료 대화상자와 상태 창은 이 상태를 '남은 것 없음'과 구별해 표시해야
    // 한다"고 못 박는 자리다. "확인하지 못했다"까지 적고 멈추면 읽는 사람은 그것을
    // "찾아봤는데 없더라"로 읽는다 — 그래서 "없다는 뜻이 아니다"를 문구가 직접 말한다.
    const n = leftoverNotice({ stopped: false, leaked: [], detail: STOP_DETAIL.unverifiable });
    expect(n.message).toContain("확인하지 못했");
    expect(n.detail).toContain(STOP_DETAIL.unverifiable);
    expect(n.detail).toContain("없다는 뜻이 아닙니다");
    // "정리했다"로도 "아무것도 안 남았다"로도 읽히면 안 된다.
    expect(n.message).not.toContain("정리를 끝냈");
  });

  it("shows every reason the supervisor joined, not just the first", () => {
    // stopAll이 서비스별 사유를 줄바꿈으로 이어 붙인다. 한 줄만 실어 보내면 두 번째
    // 서비스가 왜 깨끗하지 않았는지가 화면에서 사라진다.
    const n = leftoverNotice({
      stopped: false,
      leaked: [4242],
      detail: `${STOP_DETAIL.orphans}\napi: 종료 중 예외 — boom`,
    });
    expect(n.detail).toContain(STOP_DETAIL.orphans);
    expect(n.detail).toContain("boom");
  });

  it("falls back to 'could not verify' when no reason came back at all", () => {
    const n = leftoverNotice({ stopped: false, leaked: [] });
    expect(n.detail).toContain(STOP_DETAIL.unverifiable);
  });
});


/**
 * 창 닫기. 종료가 아니다 — 이 흐름에는 앱을 끄거나 서비스를 내릴 구멍이 타입에 아예 없다.
 */
function closeRecorder(over: Partial<CloseFlowDeps> = {}, recording = true) {
  const log: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const mark = <T>(what: string, value: T) => async () => {
    log.push(`${what}:start`);
    await tick();
    log.push(`${what}:end`);
    return value;
  };
  const deps: CloseFlowDeps = {
    isRecording: mark("isRecording", recording),
    confirm: async (message: string) => {
      asked.push(message);
      log.push("confirm:start");
      await tick();
      log.push("confirm:end");
      return true;
    },
    stopRecording: mark("handshake", { stopped: true }),
    handshakeTimeoutMs: 50,
    log: (line) => lines.push(line),
    close: () => log.push("close"),
    ...over,
  };
  return { log, lines, asked, deps };
}

describe("runCloseFlow", () => {
  it("closes silently when nothing is recording — no dialog at all", async () => {
    // 완료 기준 P2-C12: 분석 job이 running인 상태에서 창을 닫아도 확인 대화상자는 뜨지
    // 않는다. 창을 닫아도 분석은 계속되고, 그것이 이 변경의 목적이다 (스펙 §6.10).
    const { log, asked, deps } = closeRecorder({}, false);
    await runCloseFlow(deps);
    expect(asked).toEqual([]);
    expect(log).toEqual([...seq("isRecording"), "close"]);
  });

  it("finishes the handshake BEFORE the window is allowed to close", async () => {
    // 창이 먼저 죽으면 LiveRecorder.stop()이 아예 불리지 않는다 (fe/src에 beforeunload 0건).
    // 여기서는 API가 살아 있어 sweeper가 90초 뒤 실제로 발화하므로, 그 결과는 조용한
    // producer_abandoned다 — ⌘Q 경로보다 오히려 눈에 덜 띈다.
    const { log, asked, deps } = closeRecorder();
    await runCloseFlow(deps);
    expect(asked).toEqual([CLOSE_WHILE_RECORDING]);
    expect(log).toEqual([...seq("isRecording", "confirm", "handshake"), "close"]);
  });

  it("keeps the window open when the user cancels", async () => {
    const { log, deps } = closeRecorder({ confirm: async () => false });
    await runCloseFlow(deps);
    expect(log).not.toContain("close");
    expect(log).not.toContain("handshake:start");
  });

  it("still closes when the renderer refuses to stop, and says so", async () => {
    const { log, lines, deps } = closeRecorder({
      stopRecording: async () => ({ stopped: false, reason: "훅이 없어요" }),
    });
    await runCloseFlow(deps);
    expect(log[log.length - 1]).toBe("close");
    expect(lines.join("\n")).toContain("failed");
  });

  it("still closes when the renderer never answers", async () => {
    const { log, lines, deps } = closeRecorder({
      stopRecording: () => new Promise(() => undefined),
      handshakeTimeoutMs: 20,
    });
    await runCloseFlow(deps);
    expect(log[log.length - 1]).toBe("close");
    expect(lines.join("\n")).toContain("timeout");
  });

  it("tells the user the app keeps running", async () => {
    // 창 닫기는 종료가 아니다. 문구가 그렇게 말하지 않으면 사용자는 긴 전사를 중단시킬까
    // 두려워 창을 못 닫는다 (스펙 §6.10의 전제 전체가 그것이다).
    expect(CLOSE_WHILE_RECORDING).toContain("앱과 서비스는 계속 실행");
  });
});

describe("decideCloseEvent", () => {
  // main.ts의 close 핸들러는 vitest가 영영 못 부른다(electron을 값으로 import한다).
  // 그래서 **무엇을 통과시키고 무엇을 막는가**라는 판정만 여기로 꺼냈다. 래치의 수명은
  // 아래 createFlowLatch가 잠그고, main.ts에 남는 것은 preventDefault와 배선뿐이다.
  it("lets the quit path close the window, even though the quit flow is still running", () => {
    // allow()는 quitNow() 안, 흐름이 끝나기 **전에** 올라간다. 그래서 app.quit()이 닫는 창의
    // close는 running이 아직 "quit"인 채로 온다. running을 먼저 보면 그 창을 막고, 창 하나의
    // close가 막히면 Electron은 종료 자체를 취소한다 — 확인도 핸드셰이크도 끝난 종료가.
    expect(decideCloseEvent({ quitAllowed: true, closed: false, running: "quit" })).toBe(
      "let-it-close",
    );
  });

  it("asks the close flow on the first press", () => {
    expect(decideCloseEvent({ quitAllowed: false, closed: false, running: null })).toBe("run-flow");
  });

  it("lets our own close() through once the flow decided to close", () => {
    // closeNow()가 closed를 먼저 세우고 close()를 부른다. 이 갈래를 막으면 흐름을 다 돌고도
    // 창이 영영 안 닫힌다 — preventDefault를 이미 불렀기 때문이다.
    expect(decideCloseEvent({ quitAllowed: false, closed: true, running: "close" })).toBe(
      "let-it-close",
    );
  });

  it("prevents and ignores a second press while the handshake is still running", () => {
    // 재리뷰 2의 N1. 이 갈래가 "let-it-close"면 Electron이 창을 그대로 파괴해 핸드셰이크
    // 한가운데서 렌더러가 죽고, LiveRecorder.stop()이 끝나지 못해 마지막 tail 청크를 잃는다
    // → meeting.capture_error = producer_abandoned. 창 닫기 경로에는 "종료 중" 화면도 없어
    // 최대 30초 동안 아무 피드백이 없으므로 한 번 더 누르는 것은 드문 조작이 아니다.
    // "run-flow"도 안 된다 — 그러면 같은 질문을 두 번 받는다(F2가 없앤 결함).
    expect(decideCloseEvent({ quitAllowed: false, closed: false, running: "close" })).toBe(
      "ignore",
    );
  });

  it("prevents and ignores a window close while the quit flow has not yet allowed the quit", () => {
    // 재리뷰 4의 N3. 종료 흐름이 확인 대화상자·핸드셰이크·worker 유예 중 어디에 있든, 그동안의
    // ⌘W가 창을 파괴하면 종료 흐름의 핸드셰이크가 렌더러를 잃는다(P2-C13). 닫기 흐름을 새로
    // 시작하면 거의 같은 질문이 두 장 뜨고, 둘 다 승인되면 stopRecording이 겹쳐 돈다.
    expect(decideCloseEvent({ quitAllowed: false, closed: false, running: "quit" })).toBe("ignore");
  });
});

describe("decideQuitEvent", () => {
  // main.ts의 before-quit 핸들러는 vitest가 영영 못 부른다(electron을 값으로 import한다).
  // 그래서 **무엇을 통과시키고 무엇을 막는가**라는 판정만 여기로 꺼냈다.
  //
  // 통과의 근거가 `quitting`이 **아니라는 것**이 이 갈래들의 전부다. `quitting`은 beginQuit이
  // 핸드셰이크·화면·stopServices보다 앞에서 올리는 래치라, 그것을 통과 신호로 쓰면 그 긴
  // 구간의 2차 ⌘Q가 창을 파괴하고(→ producer_abandoned) detached 자식을 고아로 남긴다.
  it("lets our own app.quit() through once the flow decided to quit", () => {
    // 이 갈래를 막으면 preventDefault의 짝이 사라져 앱이 창도 없이 남아 다시는 끝나지 않는다.
    expect(decideQuitEvent({ quitAllowed: true, running: "quit" })).toBe("let-it-quit");
  });

  it("prevents and ignores a second press while the flow is still running", () => {
    // 재리뷰 3의 N4. "let-it-quit"이면 Electron이 즉시 창을 파괴하고 프로세스를 끝내 녹음의
    // 꼬리를 잃고(P2-C13) worker·API가 고아로 남는다(P1-C5·P2-C4). "run-flow"도 안 된다 —
    // 확인 대화상자가 떠 있는 동안의 2차 ⌘Q가 두 번째 흐름을 시작하던 것이 같은 결함이다.
    expect(decideQuitEvent({ quitAllowed: false, running: "quit" })).toBe("ignore");
  });

  it("prevents and ignores a quit while the close flow is running", () => {
    // 재리뷰 4의 N3의 반대 순서. ⌘W의 확인은 창에 붙은 시트라 앱 메뉴가 살아 있어 ⌘Q가
    // 실제로 들어온다. 통과시키면 닫기 흐름의 핸드셰이크 한가운데서 창이 파괴되고, 새 흐름을
    // 시작하면 질문 두 장 + 겹친 stopRecording이다.
    expect(decideQuitEvent({ quitAllowed: false, running: "close" })).toBe("ignore");
  });

  it("runs the quit flow on the first press", () => {
    expect(decideQuitEvent({ quitAllowed: false, running: null })).toBe("run-flow");
  });
});

/**
 * 판정이 아니라 **수명**을 잠근다 — 무엇이 언제 올라가고 무엇이 절대 내려가지 않는가.
 * main.ts의 핸들러는 `press()`의 결과로만 갈라지고, 흐름의 끝에서 `allow()`/`settle()`만 부른다.
 */
describe("createFlowLatch", () => {
  it("raises the entry latch on the first press so the next one is ignored", () => {
    const flows = createFlowLatch();
    expect(flows.quit.press()).toBe("run-flow");
    expect(flows.quit.press()).toBe("ignore");
    expect(flows.quit.press()).toBe("ignore");
  });

  it("lets our own quit — and the window it closes — through after allow(), even once the flow settles", () => {
    // allow()는 quitNow() 안, 흐름이 끝나기 **전에** 올라가고, main.ts의 .finally(settle)는
    // 그 **직후에** 돈다. 그 사이와 그 뒤에 두 이벤트가 온다: app.quit()의 before-quit과, 그
    // 종료가 닫는 창의 close. 재리뷰 4의 N1: settle이 통과 래치까지 내리면 전자는 방금 승인한
    // 질문을 다시 묻고, 후자는 닫기 흐름이 되어 preventDefault로 **종료 자체를 취소한다.**
    // 그 변이에 368개 테스트가 전부 초록이었다 — settle() 뒤의 press()를 부른 곳이 없었다.
    const flows = createFlowLatch();
    const win = flows.forWindow();
    expect(flows.quit.press()).toBe("run-flow");
    flows.quit.allow();
    expect(flows.quit.press()).toBe("let-it-quit");
    expect(win.press()).toBe("let-it-close");
    flows.quit.settle();
    expect(flows.quit.press()).toBe("let-it-quit");
    expect(win.press()).toBe("let-it-close");
  });

  it("asks again after a cancel, and leaves the other flow startable too", () => {
    // 확인 대화상자에서 "취소" → 흐름은 allow() 없이 끝난다. 그때 진입 래치가 내려가지 않으면
    // 사용자가 앱을(창을) **영영 끌 수 없다** — 이후 모든 입력이 preventDefault만 맞고
    // "ignore"로 삼켜진다. 도는 흐름은 두 진입점이 공유하므로, 한쪽의 취소가 다른 쪽도 풀어야 한다.
    const flows = createFlowLatch();
    const win = flows.forWindow();
    expect(flows.quit.press()).toBe("run-flow");
    flows.quit.settle();
    expect(flows.quit.press()).toBe("run-flow");
    flows.quit.settle();
    expect(win.press()).toBe("run-flow");
    win.settle();
    expect(win.press()).toBe("run-flow");
    win.settle();
    expect(flows.quit.press()).toBe("run-flow");
  });

  it("runs at most one flow: ⌘W is ignored during the quit flow, ⌘Q during the close flow", () => {
    // 재리뷰 4의 N3. 두 흐름이 각자 자기 재입력만 막으면 서로를 모른 채 같은 녹음에 동시에
    // stopRecording을 보내고, 먼저 끝난 쪽이 창을 파괴해 다른 쪽이 렌더러를 잃는다(P2-C13).
    const quitFirst = createFlowLatch();
    const w1 = quitFirst.forWindow();
    expect(quitFirst.quit.press()).toBe("run-flow");
    expect(w1.press()).toBe("ignore");
    expect(quitFirst.running()).toBe("quit");

    const closeFirst = createFlowLatch();
    const w2 = closeFirst.forWindow();
    expect(w2.press()).toBe("run-flow");
    expect(closeFirst.quit.press()).toBe("ignore");
    expect(closeFirst.running()).toBe("close");
  });

  it("releases ⌘Q after a close flow that actually closed its window", () => {
    // running은 창 밖의 공유 값이다. 닫힌 창이 그것을 쥔 채 사라지면 그 뒤의 ⌘Q가 전부
    // "ignore"로 삼켜져 앱을 영영 끌 수 없다 — 창마다 closing을 들던 시절의
    // `if (!closed) closing = false`를 그대로 옮기면 나는 결함이다.
    const flows = createFlowLatch();
    const win = flows.forWindow();
    expect(win.press()).toBe("run-flow");
    expect(win.press()).toBe("ignore");
    win.allow();
    expect(win.press()).toBe("let-it-close");
    win.settle();
    expect(flows.quit.press()).toBe("run-flow");
  });

  it("keeps `closed` per window, so a reopened window still asks", () => {
    // 창을 한 번 닫은 뒤 Dock에서 다시 연 창의 첫 ⌘W가 확인도 핸드셰이크도 없이 통과하면
    // 그 창의 녹음 꼬리를 잃는다.
    const flows = createFlowLatch();
    const first = flows.forWindow();
    expect(first.press()).toBe("run-flow");
    first.allow();
    first.settle();
    const reopened = flows.forWindow();
    expect(reopened.press()).toBe("run-flow");
  });
});

describe("HANDSHAKE_TIMEOUT_MS", () => {
  /**
   * fe 소스에서 상수 하나를 읽는다. import하지 않는 이유: live-recorder.ts는 `?worker&url` 워크릿
   * import를 가져 Vite 밖(여기 vitest)에서 불러올 수 없고, desktop이 fe 모듈에 값으로 의존하면
   * 번들 위생(P2-C14)이 흔들린다. 선언이 사라지거나 모양이 바뀌면 여기서 **던진다** — 조용히
   * NaN으로 비교해 초록이 되지 않게.
   */
  const feConstant = (file: string, name: string): number => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../fe/src", file), "utf8");
    const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(src);
    if (m === null) throw new Error(`${file}에서 ${name} 선언을 찾지 못했다`);
    return Number(m[1].replace(/_/g, ""));
  };

  it("outlasts the renderer's own worst-case live stop, so main never cuts off a stop that is still legitimately running (P2-C13)", () => {
    // LiveRecorder.stop()의 정상 경로: flush ACK를 기다리고 → 큐를 drain하고 → stop POST를 보낸다.
    // 서버 경계가 앞서 있으면 stop POST가 한 번 더 간다. 셋 다 자기 상한이 있고, 그 합이 렌더러가
    // "아직 정상적으로 멈추는 중"일 수 있는 최대 시간이다. 핸드셰이크가 그보다 먼저 포기하면 main이
    // 서비스를 내려 마지막 tail과 봉인 요청이 갈 곳을 잃는다 → capture_error = producer_abandoned.
    const recorder = fs.readFileSync(
      path.resolve(__dirname, "../../../fe/src/features/meeting/lib/live-recorder.ts"),
      "utf8",
    );
    const stopPosts = recorder.match(/this\.deps\.postStop\(/g)?.length ?? 0;
    expect(stopPosts).toBeGreaterThan(0);
    const budget =
      feConstant("features/meeting/lib/live-recorder.ts", "FLUSH_ACK_TIMEOUT_MS") +
      feConstant("features/meeting/lib/live-recorder.ts", "DRAIN_TIMEOUT_MS") +
      stopPosts * feConstant("features/meeting/api/live.ts", "REQUEST_TIMEOUT_MS");
    expect(HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(budget);
  });
});
