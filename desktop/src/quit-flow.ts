import { decideQuit, runHandshake, runWithin, STOP_DETAIL, type InFlight } from "./shutdown";
import type { StopOutcome } from "./services/types";

/**
 * ⌘Q·메뉴 종료가 실제로 무엇을 **어떤 순서로** 하는가.
 *
 * 순서 자체가 프로덕션 코드다. 세 가지가 순서에 매달려 있다.
 * - 핸드셰이크가 서비스 정지보다 **먼저 끝나야** 한다. 창이 먼저 죽으면 마지막 청크를
 *   잃고, 그것을 봉인하는 sweeper는 API의 @Cron이라 우리가 API도 내리는 이 경로에서는
 *   아무도 봉인하지 않는다 → `capture_error = producer_abandoned` (완료 기준 P2-C13).
 * - 자손 스냅샷은 확인 대화상자보다 **먼저** 한 번 찍혀야 한다. 대화상자는 시간 상한이
 *   없어서, 그 뒤에만 찍으면 사람이 커피를 마시는 동안 supervisor가 죽었을 때 그 자손을
 *   영영 못 본다 (이월 결함 N2).
 * - 되돌릴 수 없는 지점을 지난 뒤에는 **반드시** quit()이 불려야 한다. before-quit이
 *   preventDefault로 이번 종료를 막았기 때문에, 그 호출이 한 번이라도 사라지면 앱은 창도
 *   없이 남아 다시는 끝나지 않는다 (Phase 1이 값을 치른 자리다). 그래서 finally다.
 *
 * main.ts에 두면 어떤 테스트도 이것을 부를 수 없다 — electron을 값으로 import하는 파일은
 * vitest가 못 불러온다(shell-window.ts:4). 그 자리에 있는 동안 `await`를 지우는 변이도,
 * finally를 지우는 변이도 초록불로 살아남는다. 잎(대화상자·executeJavaScript·app.quit)만
 * 주입으로 받는다 — window-flow.ts와 같은 분리다.
 */
export interface QuitFlowDeps {
  /** 녹음 중인가·분석 중인가. 렌더러 훅과 `--once` 자식 조회가 채운다. */
  inFlight(): Promise<InFlight>;
  /** 확인 대화상자. 사람이 종료를 승인했는가. */
  confirm(message: string): Promise<boolean>;
  /**
   * worker 자손을 지금 찍어 둔다. 흐름이 **두 번** 부르고, 구현은 마지막으로 성공한 것을
   * 유지한다 (shutdown.ts의 captureDescendants).
   */
  captureDescendants(): Promise<void>;
  /** 되돌릴 수 없는 지점 — quitting 래치를 올리고 재시도 타이머를 끈다. */
  beginQuit(): void;
  /**
   * "종료 중" 화면을 건다. 창이 없으면 아무것도 하지 않는다.
   *
   * worker의 유예는 90초다(31분 오디오의 STT stage boundary가 분 단위일 수 있다). 그동안
   * 화면이 그대로면 ⌘Q를 누른 사람은 앱이 멎었다고 결론 내리고 **강제 종료**를 누른다 —
   * 정중한 경로가 존재하는 이유가 그것을 피하는 것인데 침묵이 그 사람을 거기로 민다.
   * P2-C5는 바로 그 순간에 깨진다.
   *
   * 그런데 이 잎은 창 하나짜리 앱에서 **내비게이션**이라 렌더러를 파괴한다. 그래서
   * 핸드셰이크보다 앞에 둘 수 없다 — runQuitFlow의 주석이 그 순서를 적어 뒀다.
   *
   * 그리고 이 프라미스는 **렌더러가 커밋해야 끝난다.** 상한은 아래 screenTimeoutMs가 건다.
   */
  showQuitting(): Promise<void>;
  /**
   * 그 화면을 기다리는 상한. 사람이 아니라 렌더러를 기다리는 시간이다.
   *
   * beginQuit()과 finally의 quit() 사이에서 **렌더러에 매달리는 대기는 전부 상한이 있어야
   * 한다.** 하나라도 없으면 봉쇄된 렌더러가 ⌘Q를 영영 끝나지 않게 만든다 — before-quit이
   * 이미 preventDefault를 불렀으므로 앱을 끌 길이 사라진다. 화면은 침묵을 줄이려고 거는
   * 것이지 종료의 전제가 아니므로, 안 뜨면 로그만 남기고 지나간다.
   */
  screenTimeoutMs: number;
  /** 렌더러의 라이브 중지. 훅이 없거나 창이 죽었으면 stopped:false로 답한다. */
  stopRecording(): Promise<{ stopped: boolean; reason?: string }>;
  /** 그 핸드셰이크의 상한. 사람이 아니라 렌더러를 기다리는 시간이다. */
  handshakeTimeoutMs: number;
  /** 감독자 역순 종료 (+ dev의 Vite). */
  stopServices(): Promise<StopOutcome>;
  /** supervisor.log. */
  log(line: string): void;
  /** 정리하지 못한 것을 사람에게 보인다. */
  warn(notice: QuitNotice): Promise<void>;
  /** 진짜 종료. */
  quit(): void;
}

/** 대화상자 한 장의 글. 버튼과 아이콘은 부르는 쪽이 정한다. */
export interface DialogCopy {
  message: string;
  detail: string;
}

/**
 * 한때 `kind: "info" | "warning"`이 여기 있었다. 사람이 "계속 기다리기"를 골라 worker를
 * 남겨 둔 결과에 경고 아이콘을 달지 않으려던 것인데, **F2가 그 상태 자체를 없앴다** —
 * 이제 "계속 기다리기"는 실제로 기다리므로 그 답으로 끝나는 종료가 존재하지 않는다.
 * 남은 둘(고아 생존 / 증명 실패)은 둘 다 경고다. 값이 하나뿐인 필드를 남겨 두면 그것을
 * 단언하는 테스트는 아무것도 지키지 못한다.
 */
export type QuitNotice = DialogCopy;

export async function runQuitFlow(deps: QuitFlowDeps): Promise<void> {
  // 가장 이른 스냅샷. 아래 confirm은 사람이 답할 때까지 무한히 막히므로, 이 한 줄이
  // "대화상자가 떠 있는 동안 supervisor가 죽었다"를 관측할 수 있는 유일한 시점이다.
  await deps.captureDescendants();
  const decision = await decideQuit(await deps.inFlight(), deps.confirm);
  if (!decision.quit) return;

  deps.beginQuit();
  try {
    // **핸드셰이크가 화면보다 먼저다.** "종료 중" 화면의 잎은 창이 하나뿐인 이 앱에서
    // `win.loadFile(shell/status.html)` — 즉 그 창의 **내비게이션**이고, 그것이 렌더러의
    // `window.__damwha_desktop`을 문서째 파괴한다. 화면을 먼저 걸면 뒤이은 핸드셰이크는
    // 언제나 `{stopped:false, reason:'no-bridge'}`를 받아, 마지막 tail 청크를 잃은 채
    // `capture_error = producer_abandoned`로 끝난다 (완료 기준 P2-C13). §6.9가 "종료
    // 순서의 맨 앞에 handshake를 둔다"고 못 박은 이유가 정확히 이것이다.
    //
    // 침묵(P2-C5)은 그래도 최소로 줄인다. 화면을 거는 시점이 두 갈래인 것이 그 때문이다.
    // - 녹음 중이 아니면 **핸드셰이크가 아예 없으므로 곧바로 건다.** 앞에 남은 긴 기다림은
    //   worker 유예 90초 하나뿐이고, 이쪽이 흔한 경우다.
    // - 녹음 중이면 핸드셰이크 **뒤에** 건다. 살아 있는 녹음의 정상 중지는 1초 남짓이라
    //   그 침묵은 짧다 — 30초는 상한이지 예상 비용이 아니다. 그 간극을 메우자고 녹음의
    //   꼬리를 버리는 것은 값이 맞지 않는다.
    if (decision.stopRecording) {
      const result = await runHandshake(deps.stopRecording, {
        timeoutMs: deps.handshakeTimeoutMs,
      });
      if (result.kind !== "stopped") {
        // 종료 자체는 막지 않는다. 막으면 사용자가 앱을 끌 수 없다. 다음 실행 때 API가
        // 뜨면 sweeper가 봉인·마감한다 (스펙 §6.9).
        deps.log(
          `녹음을 정상 중지하지 못했어요 (${result.kind}). 다음 실행 때 서버가 마무리합니다.`,
        );
      }
    }
    try {
      // 상한을 건다. 이 잎(win.loadFile)은 **렌더러가 커밋해야** 끝나는 프라미스라, 봉쇄된
      // 렌더러 하나가 아래 finally의 quit()에 영영 닿지 못하게 만든다 — before-quit이 이미
      // preventDefault를 불렀으므로 앱을 끌 길이 없어진다. isRecordingIn을 3초에 묶은 것과
      // 같은 규칙이고, 이 자리가 beginQuit과 quit 사이에 남아 있던 마지막 무상한 대기였다.
      await runWithin(deps.showQuitting, {
        timeoutMs: deps.screenTimeoutMs,
        onTimeout: () =>
          deps.log(
            `종료 화면이 ${deps.screenTimeoutMs}ms 안에 뜨지 않았어요 — 기다리지 않고 종료를 계속합니다.`,
          ),
      });
    } catch (e) {
      // 화면을 못 걸었다고 종료를 멈추지 않는다. 창이 이미 파괴되는 중이면 여기가 거부한다.
      deps.log(`종료 화면을 걸지 못했어요 — ${e instanceof Error ? e.message : String(e)}`);
    }
    // 두 번째 스냅샷. supervisor가 아직 살아 있는 마지막 지점이라 가장 새것이고, pid
    // 재사용 위험이 가장 작다. 여기서 실패해도 위에서 찍어 둔 것이 남는다.
    await deps.captureDescendants();

    const out = await deps.stopServices();
    if (!out.stopped) {
      // 정리 실패를 조용히 넘기지 않는다 (스펙 §6.9 5단계). leaked가 비어 있어도 적는다 —
      // `{stopped:false, leaked:[]}`는 "깨끗한데 보고를 안 한 것"이 아니라 "깨끗한지
      // 증명하지 못한 것"이고, 스펙은 그 둘을 구별해 보이라고 못 박는다.
      const notice = leftoverNotice(out);
      deps.log(`종료: ${notice.message} ${notice.detail.replace(/\n+/g, " ")}`);
      await deps.warn(notice);
    }
  } finally {
    deps.quit();
  }
}

/**
 * 유예가 지났을 때 묻는 말. 두 경우를 **가르는 것**이 이 함수의 전부다.
 *
 * 하나로 합쳐 두면 31분짜리 오디오의 STT 한가운데에서 정상적으로 진행 중인 사용자에게
 * "응답하지 않습니다"라고 말하게 된다 — 그 사람의 올바른 선택은 기다리는 것인데 문구가
 * 강제 종료를 권하는 꼴이다. 반대로 정말 봉쇄된 worker에게 "마무리하는 중"이라고 하면
 * 영영 오지 않을 것을 기다리게 한다.
 */
export function graceExpiryPrompt(analysing: boolean): DialogCopy {
  if (analysing) {
    return {
      message: "작업 처리기가 분석을 마무리하는 중이에요.",
      detail:
        "안전한 지점까지 끝내고 있어요. 조금 더 기다리면 거기까지가 저장되고, 지금 강제 종료하면 이 작업은 처음부터 다시 큐에 들어갑니다.",
    };
  }
  return {
    message: "작업 처리기가 응답하지 않아요.",
    detail:
      "종료 신호를 보냈지만 유예 시간 안에 끝나지 않았어요. 지금 처리 중인 분석은 보이지 않으니, 강제로 종료해도 잃을 진행 상황은 없어 보입니다.",
  };
}

/**
 * 정리하지 못한 것을 어떻게 말할 것인가. `StopOutcome.detail`이 **왜**를, 여기가 **그래서
 * 무엇을 하면 되는가**를 맡는다.
 *
 * 세 상태를 한 문장으로 뭉개지 않는 것이 detail 필드의 존재 이유다 (types.ts):
 * 고아가 살아 있다 / 확인하지 못했다 / 사람이 강제를 고르지 않아 스스로 마무리 중이다.
 * 셋째를 "정리 실패"라고 적으면 사용자가 방금 고른 것을 오류라고 말하는 셈이다.
 */
export function leftoverNotice(out: StopOutcome): QuitNotice {
  const why = out.detail ?? STOP_DETAIL.unverifiable;
  const pids =
    out.leaked.length > 0
      ? `pid ${out.leaked.join(", ")} — 이 목록은 후보이지 증거가 아니에요. 그 사이 끝난 pid를 다른 프로그램이 이미 쓰고 있을 수 있으니, 터미널에서 무엇인지 확인한 뒤에 정리해 주세요.`
      : "남은 것이 있는지 없는지를 확인하지 못했어요 — 없다는 뜻이 아닙니다. 터미널에서 damwha_worker·mlx_lm.server가 남아 있는지 직접 봐 주세요.";
  const detail = `${why}\n\n${pids}\n\n자세한 내용은 로그에 있습니다.`;

  if (out.leaked.length > 0) {
    return { message: "아직 살아 있을 수 있는 프로세스가 있어요.", detail };
  }
  // 스펙 §6.9 — "깨끗하지 않은데 무엇이 남았는지도 모른다"는 정상적으로 존재하는 상태다.
  // "정리했어요"도 "아무것도 안 남았어요"도 아니다. 둘 중 어느 쪽으로도 읽히지 않게 적는다.
  return { message: "정리가 끝났는지 확인하지 못했어요.", detail };
}


/**
 * 녹음 중에 **창을 닫을 때**의 절차 (스펙 §6.10).
 *
 * 창을 닫는 것은 종료가 아니다 — 앱도 네 서비스도 계속 산다(P2-C12). 그런데 창을 닫으면
 * 렌더러가 파괴되고, `fe/src`에 `beforeunload`·`pagehide` 훅이 0건이라 `LiveRecorder.stop()`이
 * 아예 불리지 않는다. 마지막 tail 청크가 서버에 못 들어가고, ⌘Q와 달리 API가 살아 있으므로
 * `LiveOrphanService.sweep`이 90초 뒤 **실제로 발화해** `capture_error`를 `producer_abandoned`로
 * 봉인한다. 즉 조용한 데이터 유실이고, 그래서 §6.10이 여기에도 같은 확인과 같은 핸드셰이크를
 * 요구한다.
 *
 * **분석 중에는 아무것도 하지 않는다** — 대화상자도 띄우지 않는다. 창을 닫아도 분석은
 * 계속되고 그것이 이 변경의 목적이며, P2-C12가 판정하는 것이 정확히 그 경우다.
 *
 * 이 흐름에는 **앱을 끄거나 서비스를 내릴 방법이 아예 없다** — CloseFlowDeps에 그런 구멍을
 * 두지 않았고, 앞으로도 넓히지 않는다. 창 닫기가 종료로 번지는 것이 Phase 1의 동작이었고,
 * 그 회귀는 이 인터페이스를 넓히지 않는 한 **쓸 수조차 없다.** 호출부는 main.ts에 있어
 * vitest가 영영 못 부르므로, 표현할 수 없게 만드는 타입이 그 자리에서 얻을 수 있는 가장
 * 강한 보증이다 — 부를 수 없는 호출부를 겨냥한 어떤 테스트보다 낫다.
 */
export interface CloseFlowDeps {
  /** 이 창이 지금 녹음 중인가. 렌더러 훅에 묻는다. */
  isRecording(): Promise<boolean>;
  confirm(message: string): Promise<boolean>;
  stopRecording(): Promise<{ stopped: boolean; reason?: string }>;
  handshakeTimeoutMs: number;
  log(line: string): void;
  /** 이번에는 막지 않고 창을 실제로 닫는다. */
  close(): void;
}

export const CLOSE_WHILE_RECORDING =
  "녹음이 진행 중이에요. 창을 닫으면 녹음을 먼저 안전하게 마무리합니다. 앱과 서비스는 계속 실행되니 분석은 그대로 이어져요. 창을 닫을까요?";

export async function runCloseFlow(deps: CloseFlowDeps): Promise<void> {
  // 녹음 중이 아니면 **묻지 않는다.** 분석 중이어도 마찬가지다 (스펙 §6.10, P2-C12).
  if (!(await deps.isRecording())) {
    deps.close();
    return;
  }
  // 취소하면 창을 그대로 둔다. 종료 경로와 달리 여기서 멈추는 것은 사용자를 가두지 않는다 —
  // 앱도 창도 그대로이고, 다시 닫으면 다시 묻는다.
  if (!(await deps.confirm(CLOSE_WHILE_RECORDING))) return;
  const result = await runHandshake(deps.stopRecording, { timeoutMs: deps.handshakeTimeoutMs });
  if (result.kind !== "stopped") {
    // 창 닫기 자체는 막지 않는다. 여기서는 API가 살아 있으므로 sweeper가 90초 뒤 봉인한다 —
    // 봉인은 되고 tail 청크만 잃는다. 그 사실을 조용히 넘기지 않고 적는다.
    deps.log(
      `창을 닫는 중 녹음을 정상 중지하지 못했어요 (${result.kind}). 서버가 곧 마무리합니다.`,
    );
  }
  deps.close();
}

/**
 * 창의 `close` 이벤트 하나를 어떻게 대할 것인가. **`preventDefault`는 동기로 불러야 하는데
 * 판정(`isRecording`)은 비동기**라서, main.ts의 핸들러는 "첫 close를 막고 → 흐름을 돌리고 →
 * 다시 닫는다"는 두 박자로 돈다. 그 두 박자 사이에 들어오는 이벤트를 가르는 것이 여기다.
 *
 * 세 갈래가 각각 다른 이유로 필요하다.
 * - `quitting` — 종료 경로가 닫는 창이다. 이미 확인도 핸드셰이크도 끝났으므로 **통과**시킨다.
 *   여기서 막으면 ⌘Q가 창을 못 닫는다.
 * - `closed` — 우리가 `closeNow()`에서 부른 `close()`가 돌아온 것이다. 이것도 **통과**다.
 *   막으면 흐름을 다 돌고도 창이 영영 안 닫힌다 — preventDefault를 이미 불렀기 때문이다.
 * - `closing` — 흐름이 도는 **중에 사람이 다시 누른** 것이다(⌘W·빨간 버튼). 이때 통과시키면
 *   Electron이 창을 그대로 파괴해 핸드셰이크 한가운데서 렌더러가 죽는다 —
 *   `LiveRecorder.stop()`이 끝나지 못해 마지막 tail 청크를 잃고 `capture_error`가
 *   `producer_abandoned`가 된다. 이 경로에는 "종료 중" 화면조차 없어 최대 30초 동안 아무
 *   피드백이 없으므로, 한 번 더 누르는 것은 드문 조작이 아니다. **막고 무시한다.**
 *
 * `closing`만 보고 통과시키던 것이 재리뷰 2의 N1이다. 진입 래치가 "같은 질문 두 번"을
 * 없애면서, 그 대가로 2차 입력이 즉시 파괴가 됐다. 통과의 근거는 래치가 아니라 **`closed` —
 * 우리가 닫기로 결정했다는 사실** 하나뿐이다.
 */
export type CloseGate = "let-it-close" | "ignore" | "run-flow";

export function decideCloseEvent(state: {
  quitting: boolean;
  closing: boolean;
  closed: boolean;
}): CloseGate {
  if (state.quitting || state.closed) return "let-it-close";
  if (state.closing) return "ignore";
  return "run-flow";
}

/**
 * `before-quit` 이벤트 하나를 어떻게 대할 것인가. `decideCloseEvent`와 **같은 모양의 같은
 * 결함**을 종료 경로에서 닫는다 (재리뷰 3의 N4).
 *
 * `main.ts`는 오랫동안 `if (quitting) return;`이었다 — `preventDefault` 없이 통과. 그런데
 * `quitting`은 `beginQuit()`이 **핸드셰이크(≤30초)·"종료 중" 화면·2차 스냅샷·`stopServices`의
 * worker 유예(90초)·남은 것 경고보다 전부 앞에서** 올리는 래치다. 그래서 그 긴 구간의 2차 ⌘Q가
 * 그대로 통과해 Electron이 즉시 창을 파괴하고 프로세스를 끝냈다. 결과 둘:
 * - 핸드셰이크 중이면 렌더러가 죽어 `LiveRecorder.stop()`이 못 끝나고 tail 청크를 잃는다 →
 *   `capture_error = producer_abandoned` (완료 기준 P2-C13). N1과 **똑같은 값**이다.
 * - `stopServices` 중이면 main이 먼저 죽어 `detached: true`인 worker·API·Vite가 고아로 남고
 *   (services/worker.ts, supervisor.ts가 "Electron이 죽어도 살아남는다"고 적어 둔 그것),
 *   남은 것 경고는 영영 안 뜬다 → 스펙 §6.2 / P1-C5 / P2-C4 위반.
 * 그리고 `beginQuit` **이전**(확인 대화상자가 떠 있는 동안)의 2차 ⌘Q는 `quitting`이 아직
 * 거짓이라 **두 번째 `runQuitFlow`를 시작했다** — 창 닫기에서 이미 없앤 "같은 질문 두 번"이다.
 *
 * 그래서 통과의 근거는 **`quitting`이 아니다.** `quitting`은 되돌릴 수 없는 지점을 표시하려고
 * 일부러 이르게 올리는 래치이고(그 자리를 옮기면 "취소"한 앱이 종료된 앱처럼 군다 —
 * main.ts의 주석이 값을 치른 자리다), 그것을 통과 신호로 쓴 것이 정확히 이 결함이다.
 * 통과의 근거는 오직 **`quitAllowed` — 우리가 마무리를 끝내고 `app.quit()`을 부르기로 했다는
 * 사실** 하나뿐이다. `closed`가 창 쪽에서 하는 역할과 같다.
 *
 * - `quitAllowed` — 우리 자신의 `app.quit()`이다. **통과.** 막으면 `preventDefault`를 이미
 *   불렀으므로 앱이 창도 없이 남아 다시는 끝나지 않는다 (Phase 1이 값을 치른 자리다).
 * - `quitRequested` — 흐름이 도는 중에 사람이 **다시 누른** 것이다. 막고 무시한다. 통과시키면
 *   위의 두 결과가 그대로 나고, 새 흐름을 시작하면 같은 질문을 두 번 받는다.
 * - 둘 다 아니면 첫 입력이다. 막고 흐름을 시작한다.
 */
export type QuitGate = "let-it-quit" | "ignore" | "run-flow";

export function decideQuitEvent(state: { quitAllowed: boolean; quitRequested: boolean }): QuitGate {
  if (state.quitAllowed) return "let-it-quit";
  if (state.quitRequested) return "ignore";
  return "run-flow";
}

/**
 * 그 두 래치의 **수명**. 판정만 꺼내고 래치를 main.ts에 두면 "취소한 뒤 다시 ⌘Q가 먹는가"를
 * 어떤 테스트도 부를 수 없다 — `decideQuitEvent`로 그것을 단언하려 하면 첫 입력 테스트와
 * **완전히 같은 입력**이 되어 새로 지키는 성질이 0이 된다 (재리뷰 3의 N6이 창 쪽에서 잡은 것이
 * 정확히 그 모양이다). 그래서 래치를 여기 둔다. main.ts에 남는 것은 잎(`preventDefault`·
 * `app.quit`·로그)과 배선뿐이다.
 */
export interface QuitLatch {
  /** `before-quit` 한 번. `"run-flow"`를 돌려줄 때 진입 래치를 올린다. */
  press(): QuitGate;
  /** 우리 자신의 `app.quit()` **직전**. 이 뒤의 `before-quit`만 통과한다. */
  allow(): void;
  /**
   * 흐름이 끝났다. 진입 래치를 내려 다음 ⌘Q가 다시 묻게 한다 — "취소"를 고른 뒤에도 래치가
   * 올라가 있으면 사용자가 앱을 영영 끌 수 없다.
   *
   * 조건 없이 내린다. `allow()`가 한 번 불린 뒤에는 `quitRequested` 값이 판정에 닿지 못하므로
   * (`quitAllowed`가 먼저 통과시킨다) 가드를 두면 어떤 테스트로도 죽일 수 없는 줄이 하나
   * 생긴다. 이 작업의 반복 결함이 그것이다.
   */
  settle(): void;
}

export function createQuitLatch(): QuitLatch {
  let quitAllowed = false;
  let quitRequested = false;
  return {
    press: () => {
      const gate = decideQuitEvent({ quitAllowed, quitRequested });
      if (gate === "run-flow") quitRequested = true;
      return gate;
    },
    allow: () => {
      quitAllowed = true;
    },
    settle: () => {
      quitRequested = false;
    },
  };
}
