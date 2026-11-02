import type { PillPoint } from "../app/detection-state";
import { createAskedWindow, type AskedWindowHost } from "./asked-window";
import {
  parsePillAnswer,
  PILL_ASK_SCRIPT,
  pillBounds,
  pillClamp,
  pillDefaultPosition,
  pillFits,
  pillPositionOf,
  pillRenderCall,
  type PillAnswer,
  type PillView,
  type Rect,
} from "./pill-view";

/**
 * 녹음 중 알약 창. 수명과 묻기 고리는 asked-window.ts이고, 여기는 자리와 크기를 맡는다.
 *
 * 자리(`position`)는 창보다 오래 산다. 경고 카드로 펼쳐 창이 닫혀도 남아 알약이 같은 곳으로 돌아오고,
 * 새 시작 제안의 `forget()`까지 유지된다. 호버·드래그·드롭·refit은 페이지를 다시 그리지 않는다 —
 * 다시 그리면 눌린 `중지`의 잠금이 풀린다.
 */
export interface PillWindowHost<W>
  extends Pick<AskedWindowHost<W, PillView, PillAnswer>, "alive" | "close" | "onLoad" | "onClosed" | "run" | "log"> {
  /** 창을 만들고 pill.html을 건다. 포커스를 뺏지 않고 띄워야 한다. */
  create(bounds: Rect): W;
  bounds(win: W): Rect;
  setBounds(win: W, bounds: Rect): void;
  workAreas(): Rect[];
  /** 커서가 있는 화면의 표시 영역. */
  cursorArea(): Rect;
  saved(): PillPoint | null;
  save(p: PillPoint): void;
  labels(): { stop: string; open: string };
  onAction(token: number, action: "stop" | "open"): void;
}

export interface PillWindow {
  show(view: PillView): void;
  hide(): void;
  dispose(): void;
  /** 화면 구성이 바뀐 뒤 알약이 화면 밖이면 기본 위치로 옮긴다. 저장값은 건드리지 않는다. */
  refit(): void;
  /** 이번 녹음에서 알약이 쓰는 자리. 없으면 null. */
  anchor(): PillPoint | null;
  /** 자리를 잊는다. 다음 show가 저장값이나 기본 위치로 다시 정한다. */
  forget(): void;
}

export function createPillWindow<W>(host: PillWindowHost<W>): PillWindow {
  let position: PillPoint | null = null;
  let hover = false;

  const fallback = () => pillDefaultPosition(host.cursorArea());

  const onAnswer = (answer: PillAnswer) => {
    const win = asked.window();
    if (win === null || asked.view()?.token !== answer.token) return;
    if ("action" in answer) {
      host.onAction(answer.token, answer.action);
      return;
    }
    // 드래그 중인 창은 position보다 앞서 있으므로 지금 자리는 창에서 읽는다.
    const here = pillPositionOf(host.bounds(win));
    switch (answer.ui) {
      case "hover":
        hover = answer.on;
        host.setBounds(win, pillBounds(here, hover));
        return;
      case "drag":
        host.setBounds(win, pillBounds({ x: here.x + answer.dx, y: here.y + answer.dy }, hover));
        return;
      case "drop": {
        const dropped = pillClamp(here, host.workAreas());
        host.setBounds(win, pillBounds(dropped, hover));
        position = dropped;
        host.save(dropped);
      }
    }
  };

  const asked = createAskedWindow<W, PillView, PillAnswer>({
    create: () => {
      const wanted = position ?? host.saved();
      position = wanted !== null && pillFits(wanted, host.workAreas()) ? wanted : fallback();
      hover = false;
      return host.create(pillBounds(position, false));
    },
    alive: host.alive,
    close: host.close,
    onLoad: host.onLoad,
    onClosed: host.onClosed,
    run: host.run,
    render: (view) => pillRenderCall(view, host.labels()),
    askScript: PILL_ASK_SCRIPT,
    parse: parsePillAnswer,
    what: "녹음 표시",
    onAction: onAnswer,
    log: host.log,
  });

  return {
    show(view) {
      const shown = asked.view();
      if (asked.window() !== null && shown?.token === view.token && shown.startedAt === view.startedAt) return;
      asked.show(view);
    },
    hide: asked.hide,
    dispose: asked.dispose,
    refit() {
      if (position === null || pillFits(position, host.workAreas())) return;
      position = fallback();
      const win = asked.window();
      if (win !== null) host.setBounds(win, pillBounds(position, hover));
    },
    anchor: () => position,
    forget() {
      position = null;
    },
  };
}
