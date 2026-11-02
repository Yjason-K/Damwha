import { describe, expect, it } from "vitest";
import {
  parsePillAnswer,
  pillBounds,
  pillClamp,
  pillDefaultPosition,
  pillFits,
  pillPositionOf,
  pillRenderCall,
} from "../../src/windows/pill-view";

const main = { x: 0, y: 25, width: 1440, height: 875 };
const left = { x: -1920, y: 0, width: 1920, height: 1055 };

describe("pill-view", () => {
  it("기본 위치는 오른쪽 위 12px", () => {
    expect(pillDefaultPosition(main)).toEqual({ x: 1440 - 88 - 12, y: 37 });
  });
  it("호버는 왼쪽으로 늘어나고 오른쪽 끝은 그대로다", () => {
    expect(pillBounds({ x: 500, y: 40 }, true)).toEqual({ x: 448, y: 40, width: 140, height: 32 });
    expect(pillBounds({ x: 500, y: 40 }, false)).toEqual({ x: 500, y: 40, width: 88, height: 32 });
    expect(pillPositionOf({ x: 448, y: 40, width: 140, height: 32 })).toEqual({ x: 500, y: 40 });
  });
  it("호버 크기가 화면 안에 들어가야 맞다", () => {
    expect(pillFits({ x: 52, y: 40 }, [main])).toBe(true);
    expect(pillFits({ x: 51, y: 40 }, [main])).toBe(false);
    expect(pillFits({ x: 10, y: 40 }, [main])).toBe(false);
  });
  it("놓으면 가장 가까운 화면 안으로 밀어 넣는다", () => {
    expect(pillClamp({ x: 10, y: 0 }, [main])).toEqual({ x: 52, y: 25 });
    expect(pillClamp({ x: -80, y: 300 }, [main, left])).toEqual({ x: -88, y: 300 });
  });
  it("숫자가 아닌 드래그는 거부한다", () => {
    expect(parsePillAnswer({ token: 1, ui: "drag", dx: Infinity, dy: 0 })).toBeNull();
    expect(parsePillAnswer({ token: 1, action: "start" })).toBeNull();
    expect(parsePillAnswer({ token: 1, ui: "hover", on: true })).toEqual({ token: 1, ui: "hover", on: true });
    expect(parsePillAnswer({ token: 1, action: "stop" })).toEqual({ token: 1, action: "stop" });
    expect(parsePillAnswer({ token: 1, ui: "drop" })).toEqual({ token: 1, ui: "drop" });
    expect(parsePillAnswer({ token: 1, ui: "drag", dx: 3, dy: -4 })).toEqual({ token: 1, ui: "drag", dx: 3, dy: -4 });
    expect(parsePillAnswer(null)).toBeNull();
  });
  it("문구는 JSON으로만 싣는다", () => {
    const call = pillRenderCall({ kind: "pill", token: 1, startedAt: 5, stopRetry: 0 }, { stop: '"); x(', open: "o" });
    expect(call).toContain(JSON.stringify('"); x('));
    expect(call).toContain("__damwha_pill_render");
  });
});
