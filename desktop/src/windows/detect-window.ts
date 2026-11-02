import { createAskedWindow, type AskedWindowHost } from "./asked-window";
import {
  cardViewModel,
  DETECT_ASK_SCRIPT,
  detectRenderCall,
  parseDetectAnswer,
  type CardOnlyView,
  type DetectAnswer,
} from "./detect-view";
import type { UiLanguage } from "../i18n/locale";

export { ASK_RETRY_LIMIT } from "./asked-window";

/**
 * 회의 감지 카드 창. 수명과 묻기 고리는 asked-window.ts이고, 여기는 카드의 그리기와 답 판정만 잇는다.
 */
export type DetectWindowHost<W> = Pick<
  AskedWindowHost<W, CardOnlyView, DetectAnswer>,
  "create" | "alive" | "close" | "onLoad" | "onClosed" | "run" | "onAction" | "log"
> & {
  lang(): UiLanguage;
};

export interface DetectWindow {
  show(view: CardOnlyView): void;
  hide(): void;
  dispose(): void;
}

export function createDetectWindow<W>(host: DetectWindowHost<W>): DetectWindow {
  return createAskedWindow<W, CardOnlyView, DetectAnswer>({
    ...host,
    render: (view) => detectRenderCall(view, cardViewModel(view, host.lang())),
    askScript: DETECT_ASK_SCRIPT,
    parse: parseDetectAnswer,
    what: "감지 카드",
  });
}
