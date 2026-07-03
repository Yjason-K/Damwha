import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { MeetingPage } from "@/pages/meeting";

// vitest는 globals 없이 돌므로 RTL 자동 cleanup이 걸리지 않는다 — 명시 등록.
afterEach(cleanup);

test("회의 셸은 전사·인사이트·플레이어를 렌더한다", () => {
  render(<MeetingPage />);
  expect(
    screen.getByRole("heading", { level: 1, name: "기획회의 — UI 개선안" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("log", { name: "회의 전사" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "재생" })).toBeInTheDocument();
  // 화자 검증 배너 — 확인하면 사라진다
  const confirmBtn = screen.getByRole("button", { name: "맞아요" });
  fireEvent.click(confirmBtn);
  expect(screen.queryByRole("button", { name: "맞아요" })).toBeNull();
});

test("사이드바에서 다른 회의로 이동할 수 있다", () => {
  render(<MeetingPage />);
  fireEvent.click(screen.getByRole("button", { name: /스프린트 회고/ }));
  expect(
    screen.getByRole("heading", { level: 1, name: "스프린트 회고" }),
  ).toBeInTheDocument();
});

test("모든 회의(전역 렌즈) 뷰로 전환하고 렌즈 탭을 바꿀 수 있다", () => {
  render(<MeetingPage />);
  fireEvent.click(screen.getByRole("button", { name: "모든 회의" }));
  expect(
    screen.getByRole("heading", { level: 1, name: "내 액션아이템" }),
  ).toBeInTheDocument();
  // Radix Tabs는 mousedown으로 탭을 활성화한다
  fireEvent.mouseDown(screen.getByRole("tab", { name: "결정사항" }));
  expect(
    screen.getByRole("heading", { level: 1, name: "내 결정사항" }),
  ).toBeInTheDocument();
});
