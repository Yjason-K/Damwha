import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import type { LiveUtterance } from "../model/types";
import { LiveTranscript } from "./live-transcript";

afterEach(cleanup);

const item = (seq: number, o: Partial<LiveUtterance> = {}): LiveUtterance => ({
  id: `lut_${seq}`,
  seq,
  t: `00:0${seq}`,
  startMs: seq * 1000,
  text: `발화 ${seq}`,
  speakerName: null,
  similarity: null,
  ...o,
});

test("추정 화자는 이름과 유사도로, 미식별은 '화자 ?'로 그린다", () => {
  render(
    <LiveTranscript
      items={[item(0, { speakerName: "영재", similarity: 0.82 }), item(1)]}
    />,
  );
  expect(screen.getByText("영재")).toBeInTheDocument();
  expect(screen.getByText("추정 82%")).toBeInTheDocument();
  expect(screen.getByText("화자 ?")).toBeInTheDocument();
  expect(screen.getByRole("log")).toHaveTextContent("발화 0");
});

test("위로 스크롤하면 따라가기가 꺼지고 버튼으로 복귀한다", () => {
  const { rerender } = render(<LiveTranscript items={[item(0)]} />);
  const log = screen.getByRole("log");
  Object.defineProperty(log, "scrollHeight", {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(log, "clientHeight", {
    value: 200,
    configurable: true,
  });
  log.scrollTop = 0;
  fireEvent.scroll(log);
  expect(
    screen.getByRole("button", { name: "자동 따라가기" }),
  ).toBeInTheDocument();
  rerender(<LiveTranscript items={[item(0), item(1)]} />);
  fireEvent.click(screen.getByRole("button", { name: "자동 따라가기" }));
  expect(screen.queryByRole("button", { name: "자동 따라가기" })).toBeNull();
});

test("비어 있으면 안내 문구를 그린다", () => {
  render(<LiveTranscript items={[]} />);
  expect(screen.getByText("첫 발화를 기다리고 있어요")).toBeInTheDocument();
});
