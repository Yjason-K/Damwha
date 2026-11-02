import type { PillPoint } from "../app/detection-state";
import type { CardView } from "../app/meeting-detection";

/**
 * 녹음 중 알약의 **판정**: 어디에 둘지, 페이지의 답이 맞는 모양인지. 창(pill-window.ts)과 페이지는
 * 여기서 나온 값만 다룬다. electron을 import하지 않는다.
 *
 * 위치는 언제나 **줄어든 알약의 왼쪽 위**다. 호버하면 왼쪽으로 늘어나 오른쪽 끝이 그대로다.
 */

/** 줄어든 크기. `1:02:34`가 잘리지 않게 스파이크의 92·144에서 넓혔다. */
export const PILL_COMPACT = { width: 104, height: 32 } as const;
export const PILL_HOVER = { width: 156, height: 32 } as const;

/** 위쪽·오른쪽 여백(px). */
const MARGIN = 12;

/** 호버가 왼쪽으로 늘어나는 폭. */
const GROW = PILL_HOVER.width - PILL_COMPACT.width;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PillView = Extract<CardView, { kind: "pill" }>;

/** 표시 영역의 오른쪽 위. */
export function pillDefaultPosition(area: Rect): PillPoint {
  return { x: area.x + area.width - PILL_COMPACT.width - MARGIN, y: area.y + MARGIN };
}

/** 창이 차지하는 사각형. 호버는 왼쪽으로 늘어난다. */
export function pillBounds(p: PillPoint, hover: boolean): Rect {
  return hover
    ? { x: p.x - GROW, y: p.y, width: PILL_HOVER.width, height: PILL_HOVER.height }
    : { x: p.x, y: p.y, width: PILL_COMPACT.width, height: PILL_COMPACT.height };
}

/** 창 사각형에서 줄어든 알약의 왼쪽 위를 거꾸로 구한다. */
export function pillPositionOf(bounds: Rect): PillPoint {
  return { x: bounds.x + bounds.width - PILL_COMPACT.width, y: bounds.y };
}

/** 호버 크기 기준으로 한 화면 안에 통째로 들어가는가. */
export function pillFits(p: PillPoint, areas: Rect[]): boolean {
  const b = pillBounds(p, true);
  return areas.some(
    (a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height,
  );
}

function distanceTo(a: Rect, x: number, y: number): number {
  const dx = Math.max(a.x - x, 0, x - (a.x + a.width));
  const dy = Math.max(a.y - y, 0, y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/** 알약 중심에서 가장 가까운 화면을 골라, 호버 크기가 들어가게 자른다. */
export function pillClamp(p: PillPoint, areas: Rect[]): PillPoint {
  if (areas.length === 0) return p;
  const cx = p.x + PILL_COMPACT.width / 2;
  const cy = p.y + PILL_COMPACT.height / 2;
  let best = areas[0];
  for (const a of areas) if (distanceTo(a, cx, cy) < distanceTo(best, cx, cy)) best = a;
  const minX = best.x + GROW;
  const maxX = Math.max(minX, best.x + best.width - PILL_COMPACT.width);
  const minY = best.y;
  const maxY = Math.max(minY, best.y + best.height - PILL_COMPACT.height);
  return { x: Math.min(Math.max(p.x, minX), maxX), y: Math.min(Math.max(p.y, minY), maxY) };
}

/** 알약이 main에게 보내는 것. parsePillAnswer가 모양을 강제한다. */
export type PillAnswer =
  | { token: number; action: "stop" | "open" }
  | { token: number; ui: "hover"; on: boolean }
  | { token: number; ui: "drag"; dx: number; dy: number }
  | { token: number; ui: "drop" };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 페이지가 보낸 값은 렌더러 데이터다. 모양이 맞지 않으면 null. */
export function parsePillAnswer(raw: unknown): PillAnswer | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { token?: unknown; action?: unknown; ui?: unknown; on?: unknown; dx?: unknown; dy?: unknown };
  if (!finite(r.token)) return null;
  const token = r.token;
  if (r.action !== undefined) {
    return r.action === "stop" || r.action === "open" ? { token, action: r.action } : null;
  }
  switch (r.ui) {
    case "hover":
      return typeof r.on === "boolean" ? { token, ui: "hover", on: r.on } : null;
    case "drag":
      return finite(r.dx) && finite(r.dy) ? { token, ui: "drag", dx: r.dx, dy: r.dy } : null;
    case "drop":
      return { token, ui: "drop" };
    default:
      return null;
  }
}

/** 페이지에 다음 동작을 묻는 식. main이 건 호출의 반환값이다. */
export const PILL_ASK_SCRIPT = "window.__damwha_pill ? window.__damwha_pill.next() : null";

/** main → 알약의 한 방향 호출문. 값은 JSON.stringify로만 싣는다 (detectRenderCall과 같은 이유). */
export function pillRenderCall(view: PillView, labels: { stop: string; open: string }): string {
  return `void window.__damwha_pill_render?.(${JSON.stringify({
    token: view.token,
    startedAt: view.startedAt,
    stop: labels.stop,
    open: labels.open,
  })});`;
}
