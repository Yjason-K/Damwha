import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import {
  CaptureErrorNotice,
  LiveBanner,
  isHeartbeatStale,
} from "./live-banner";

afterEach(cleanup);

const T0 = new Date("2026-09-05T10:00:00.000Z").getTime();

test("경과 시간은 recorded_at 기준이다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:12:20.000Z"
      onStop={() => {}}
      onCancel={() => {}}
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
      onCancel={() => {}}
      stopping={false}
      now={() => T0}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("워커를 기다리는 중");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onStop).toHaveBeenCalled();
});

// 워커는 heartbeat 주기(30초)를 기다린 뒤에야 첫 박을 찍으므로 locked_at은 매 박
// 직전 정확히 30초 늙는다. 임계값이 주기와 같으면 건강한 녹음마다 빨간 배너가
// 번쩍인다 — 그 경계가 이 테스트의 요점이다 (be/worker/.../config.py 참조).
test("정상 박동 주기(30초 언저리)는 신호 끊김이 아니다", () => {
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 30_500)).toBe(false);
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 59_000)).toBe(false);
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      onCancel={() => {}}
      stopping={false}
      now={() => T0 + 60_000}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("녹음 중");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("heartbeat가 박동 주기의 세 배 넘게 멈추면 신호 끊김으로 바뀐다", () => {
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 91_000)).toBe(true);
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 89_000)).toBe(false);
  expect(isHeartbeatStale(null, T0)).toBe(false);
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      onCancel={() => {}}
      stopping={false}
      now={() => T0 + 120_000}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("워커 신호가 끊겼어요");
});

// 워커가 죽은 상태에서 stop은 아무 일도 하지 않는다 — 플래그를 읽어 줄 워커가 없다.
// 회의는 reaper의 stale 창(30분) 내내 recording으로 남고 새 녹음이 막힌다.
test("신호가 끊긴 배너의 버튼은 stop이 아니라 cancel을 부른다", () => {
  const onStop = vi.fn();
  const onCancel = vi.fn();
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={onStop}
      onCancel={onCancel}
      stopping={false}
      now={() => T0 + 120_000}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "녹음 취소" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onStop).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("재처리로 그 파일을");
});

test("업로드 백로그가 30초를 넘으면 경고 문구를 보여준다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      onCancel={() => {}}
      stopping={false}
      now={() => T0}
      backlogMs={45_000}
    />,
  );
  expect(screen.getByText(/업로드가 밀리고/)).toBeInTheDocument();
});

test("백로그가 30초 이하면 경고 문구를 보이지 않는다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      onCancel={() => {}}
      stopping={false}
      now={() => T0}
      backlogMs={10_000}
    />,
  );
  expect(screen.queryByText(/업로드가 밀리고/)).toBeNull();
});

test("레코더가 실패하면 눈에 띄게 종료됐음을 보여준다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      onCancel={() => {}}
      stopping={false}
      now={() => T0}
      backlogMs={61_000}
      failed="buffer_overflow"
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("녹음이 중단됐어요");
});

test("레코더 실패 배너의 버튼도 종료(stop)를 부른다 — 서버엔 이미 녹음이 있다", () => {
  const onStop = vi.fn();
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={onStop}
      onCancel={() => {}}
      stopping={false}
      now={() => T0}
      failed="device_ended"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "종료" }));
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("종료 중에는 버튼이 잠긴다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:00:00.000Z"
      onStop={() => {}}
      onCancel={() => {}}
      stopping
      now={() => T0}
    />,
  );
  expect(screen.getByRole("button", { name: /종료/ })).toBeDisabled();
});

// capture_error는 error와 분리된 필드다 — 최종 처리가 성공해 회의가 done이 된 뒤에도
// "브라우저 연결이 끊겨 여기까지 녹음됐다"는 사실은 남아야 한다.
test("producer_abandoned면 회의가 done이 된 뒤에도 캡처 이력을 보여준다", () => {
  render(<CaptureErrorNotice error={{ code: "producer_abandoned" }} />);
  expect(screen.getByText(/연결이 끊겨/)).toBeInTheDocument();
});

test("capture_error가 없으면 아무것도 그리지 않는다", () => {
  const { container } = render(<CaptureErrorNotice error={null} />);
  expect(container).toBeEmptyDOMElement();
});

test("모르는 code는 아무것도 그리지 않는다", () => {
  const { container } = render(
    <CaptureErrorNotice error={{ code: "something_new" }} />,
  );
  expect(container).toBeEmptyDOMElement();
});

// 브라우저가 stop의 X-Capture-Error로 보낸 사유들. 서버가 capture_error에 남기는데
// 배너가 그리지 않으면 그 쓰기는 아무도 읽지 않는 죽은 컬럼이 된다.
test.each([
  ["device_ended", /마이크 연결이 끊겨/],
  ["buffer_overflow", /업로드가 너무 밀려/],
  ["upload_failed", /업로드가 거절돼/],
  ["capture_failed", /중간에 멈춰/],
  ["capture_gap", /일부 구간이 기록되지 않았어요/],
])("%s 캡처 이력을 문구로 보여준다", (code, pattern) => {
  render(<CaptureErrorNotice error={{ code }} />);
  expect(screen.getByText(pattern)).toBeInTheDocument();
});
