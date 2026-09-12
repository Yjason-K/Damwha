import { decideQuit, runHandshake, STOP_DETAIL, type InFlight } from "./shutdown";
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

export interface QuitNotice extends DialogCopy {
  /**
   * 경고 아이콘을 붙일 것인가. 사람이 "계속 기다리기"를 고른 결과에 경고 아이콘을 달면
   * 방금 고른 것을 오류라고 말하는 셈이라, 이 구분까지가 한 세트다. 잎(main.ts)은 이 값을
   * dialog의 type으로 옮기기만 한다 — 거기서 고르게 두면 어떤 테스트도 그 선택을 못 본다.
   */
  kind: "info" | "warning";
}

export async function runQuitFlow(deps: QuitFlowDeps): Promise<void> {
  // 가장 이른 스냅샷. 아래 confirm은 사람이 답할 때까지 무한히 막히므로, 이 한 줄이
  // "대화상자가 떠 있는 동안 supervisor가 죽었다"를 관측할 수 있는 유일한 시점이다.
  await deps.captureDescendants();
  const decision = await decideQuit(await deps.inFlight(), deps.confirm);
  if (!decision.quit) return;

  deps.beginQuit();
  try {
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
      : "남은 pid를 특정하지 못했어요. 터미널에서 damwha_worker·mlx_lm.server가 남아 있는지 봐 주세요.";
  const detail = `${why}\n\n${pids}\n\n자세한 내용은 로그에 있습니다.`;

  // 포함 비교인 이유: supervisor.stopAll이 서비스별 detail을 줄바꿈으로 이어 붙이므로
  // 같은지 보면 서비스가 둘 이상 사유를 낸 순간 이 갈래가 조용히 죽는다.
  if (why.includes(STOP_DETAIL.declined)) {
    // 사용자가 방금 고른 결과다. 경고가 아니라 안내다.
    return { kind: "info", message: "작업 처리기가 아직 마무리 중이에요.", detail };
  }
  if (out.leaked.length > 0) {
    return { kind: "warning", message: "아직 살아 있을 수 있는 프로세스가 있어요.", detail };
  }
  // 스펙 §6.9 — "깨끗하지 않은데 무엇이 남았는지도 모른다"는 정상적으로 존재하는 상태다.
  return { kind: "warning", message: "정리를 끝까지 확인하지 못했어요.", detail };
}
