import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { LiveBanner, isHeartbeatStale } from "./live-banner";

afterEach(cleanup);

const T0 = new Date("2026-09-05T10:00:00.000Z").getTime();

test("경과 시간은 recorded_at 기준이다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:12:20.000Z"
      onStop={() => {}}
      stopping={false}
      now={() => T0 + 12 * 60_000 + 34_000}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("녹음 중");
  expect(screen.getByRole("status")).toHaveTextContent("12:34");
});

test("job이 아직 queued면 워커를 기다린다고 알리고 버튼은 취소가 된다", () => {
  const onStop = vi.fn();
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage={null}
      heartbeatAt={null}
      onStop={onStop}
      stopping={false}
      now={() => T0}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("워커를 기다리는 중");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onStop).toHaveBeenCalled();
});

test("heartbeat가 30초 넘게 멈추면 신호 끊김으로 바뀐다", () => {
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 31_000)).toBe(true);
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 29_000)).toBe(false);
  expect(isHeartbeatStale(null, T0)).toBe(false);
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      stopping={false}
      now={() => T0 + 60_000}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("워커 신호가 끊겼어요");
});

test("종료 중에는 버튼이 잠긴다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      stopping
      now={() => T0}
    />,
  );
  expect(screen.getByRole("button", { name: /종료/ })).toBeDisabled();
});
