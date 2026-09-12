import { describe, expect, it } from "vitest";
import {
  CLOSE_WHILE_RECORDING,
  decideCloseEvent,
  graceExpiryPrompt,
  leftoverNotice,
  runCloseFlow,
  runQuitFlow,
  type CloseFlowDeps,
  type QuitFlowDeps,
} from "../src/quit-flow";
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
  // 그래서 **무엇을 통과시키고 무엇을 막는가**라는 판정만 여기로 꺼냈다. main.ts에 남는 것은
  // 배선뿐이다: 래치 두 개를 들고, 통과가 아닌 두 갈래에서 preventDefault를 부른다.
  it("lets the quit path close the window", () => {
    // ⌘Q가 닫는 창은 이미 확인도 핸드셰이크도 끝났다. 여기서 막으면 종료가 창을 못 닫는다.
    expect(decideCloseEvent({ quitting: true, closing: false, closed: false })).toBe("let-it-close");
    expect(decideCloseEvent({ quitting: true, closing: true, closed: false })).toBe("let-it-close");
  });

  it("asks the close flow on the first press", () => {
    expect(decideCloseEvent({ quitting: false, closing: false, closed: false })).toBe("run-flow");
  });

  it("lets our own close() through once the flow decided to close", () => {
    // closeNow()가 closed를 먼저 세우고 close()를 부른다. 이 갈래를 막으면 흐름을 다 돌고도
    // 창이 영영 안 닫힌다 — preventDefault를 이미 불렀기 때문이다.
    expect(decideCloseEvent({ quitting: false, closing: true, closed: true })).toBe("let-it-close");
  });

  it("prevents and ignores a second press while the handshake is still running", () => {
    // 재리뷰 2의 N1. 이 갈래가 "let-it-close"면 Electron이 창을 그대로 파괴해 핸드셰이크
    // 한가운데서 렌더러가 죽고, LiveRecorder.stop()이 끝나지 못해 마지막 tail 청크를 잃는다
    // → meeting.capture_error = producer_abandoned. 창 닫기 경로에는 "종료 중" 화면도 없어
    // 최대 30초 동안 아무 피드백이 없으므로 한 번 더 누르는 것은 드문 조작이 아니다.
    // "run-flow"도 안 된다 — 그러면 같은 질문을 두 번 받는다(F2가 없앤 결함).
    expect(decideCloseEvent({ quitting: false, closing: true, closed: false })).toBe("ignore");
  });

  it("closes on the very next press after the user cancelled", () => {
    // "취소"는 closed를 세우지 않고 finally가 래치를 내린다. 그 다음 ⌘W는 다시 묻는다.
    expect(decideCloseEvent({ quitting: false, closing: false, closed: false })).toBe("run-flow");
  });
});
