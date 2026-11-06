import type { CardAction, CardView } from "../app/meeting-detection";
import { t } from "../i18n/dictionary";
import type { UiLanguage } from "../i18n/locale";

/**
 * 회의 감지 카드의 **판정**: 어느 문구·어느 버튼을 그릴지, 어디에 둘지. 창(detect-window.ts)과 페이지
 * (shell/detect.html)는 여기서 나온 값만 다룬다. electron을 import하지 않는다.
 */

/** 카드 창에 그리는 뷰. 알약은 따로 그린다. */
export type CardOnlyView = Exclude<CardView, { kind: "pill" }>;

/** 위쪽 여백(px). */
const TOP_MARGIN = 12;

/** 표시 영역의 위쪽 가운데. 보조 모니터는 원점(x, y)을 더해야 맞는다. */
export function detectCardBounds(
  display: { x: number; y: number; width: number },
  size: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(display.x + (display.width - size.width) / 2),
    y: display.y + TOP_MARGIN,
    width: size.width,
    height: size.height,
  };
}

export interface CardButton {
  label: string;
  action: CardAction;
  primary: boolean;
}

export interface CardViewModel {
  title: string;
  detail: string;
  buttons: CardButton[];
}

export function cardViewModel(view: CardOnlyView, lang: UiLanguage): CardViewModel {
  const open: CardButton[] = [{ label: t(lang, "detect.open"), action: "open", primary: true }];
  switch (view.kind) {
    case "prompt":
      return {
        title: t(lang, "detect.prompt.title"),
        detail: t(lang, "detect.prompt.detail"),
        buttons: [
          { label: t(lang, "detect.start"), action: "start", primary: true },
          { label: t(lang, "detect.dismiss"), action: "dismiss", primary: false },
        ],
      };
    case "recording":
      return {
        title: t(lang, view.micOnly ? "detect.recording.micOnly" : "detect.recording.title"),
        detail: view.micSwitched ? t(lang, "detect.recording.micSwitched") : "",
        buttons: [{ label: t(lang, "detect.stop"), action: "stop", primary: false }],
      };
    case "finished":
      switch (view.variant) {
        case "done":
          return { title: t(lang, "detect.done.title"), detail: "", buttons: open };
        case "interrupted":
          return {
            title: t(lang, "detect.interrupted.title"),
            detail: t(lang, "detect.interrupted.detail"),
            buttons: open,
          };
        case "empty":
          return { title: t(lang, "detect.empty.title"), detail: "", buttons: [] };
        case "lost":
          return { title: t(lang, "detect.lost.title"), detail: t(lang, "detect.lost.detail"), buttons: [] };
        case "startFailed":
          return { title: t(lang, "detect.startFailed.title"), detail: "", buttons: [] };
      }
  }
}

/** 카드가 main에게 보내는 것 — 이것 하나뿐이다 (parseDetectAnswer가 강제한다). */
export interface DetectAnswer {
  token: number;
  action: CardAction;
}

const ACTIONS: readonly CardAction[] = ["start", "dismiss", "stop", "open"];

/** 페이지가 보낸 값은 렌더러 데이터다. 모양이 맞지 않으면 null. */
export function parseDetectAnswer(raw: unknown): DetectAnswer | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { token?: unknown; action?: unknown };
  if (typeof r.token !== "number" || !Number.isFinite(r.token)) return null;
  if (typeof r.action !== "string" || !(ACTIONS as readonly string[]).includes(r.action)) return null;
  return { token: r.token, action: r.action as CardAction };
}

/** 페이지에 다음 동작을 묻는 식. 렌더러 → main 채널이 아니라 main이 건 호출의 반환값이다. */
export const DETECT_ASK_SCRIPT = "window.__damwha_detect ? window.__damwha_detect.next() : null";

/** main → 카드의 한 방향 호출문. 값은 JSON.stringify로만 싣는다 (status-view.ts renderCall과 같은 이유). */
export function detectRenderCall(view: CardOnlyView, model: CardViewModel): string {
  return `void window.__damwha_detect_render?.(${JSON.stringify({ token: view.token, ...model })});`;
}
