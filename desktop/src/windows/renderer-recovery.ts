import type { MessageBoxOptions } from "electron";

/**
 * 렌더러가 죽은 창을 사람이 되살리게 한다 (#145). 띄우는 것과 `webContents.reload()`는 main.ts다.
 *
 * 자동으로 다시 불러오지 않는다 — 같은 원인으로 거듭 죽으면 루프가 된다. 사람이 고른다.
 * View > Reload는 죽은 창에서 아무것도 하지 않았다(실측). `webContents.reload()`는 새 렌더러를 띄워 화면과
 * `window.__damwha_desktop`을 되살렸다(실측) — 그래서 대화상자가 유일한 복구 수단이다.
 */
export type RendererGoneAction = "prompt" | "ignore";

export function decideRendererGone(state: {
  /** `render-process-gone`의 `details.reason`. */
  reason: string;
  /** 되돌릴 수 없는 종료 지점(`beginQuit`)을 지났다. */
  quitting: boolean;
  destroyed: boolean;
  /** 이 창에 이미 이 대화상자가 떠 있다. */
  prompting: boolean;
}): RendererGoneAction {
  if (state.reason === "clean-exit") return "ignore";
  if (state.quitting || state.destroyed || state.prompting) return "ignore";
  return "prompt";
}

export const RENDERER_GONE_BUTTONS = ["다시 불러오기", "나중에"] as const;

export function rendererGoneDialogOptions(): MessageBoxOptions {
  return {
    type: "warning",
    message: "화면이 응답을 멈췄어요",
    detail:
      "다시 불러오면 이어서 쓸 수 있어요. 이 창에서 녹음 중이었다면 녹음은 서버가 마무리합니다. 나중에 하려면 창을 닫았다가 다시 열어도 됩니다.",
    buttons: [...RENDERER_GONE_BUTTONS],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

export function rendererGoneChoice(response: number): "reload" | "later" {
  return response === 0 ? "reload" : "later";
}
