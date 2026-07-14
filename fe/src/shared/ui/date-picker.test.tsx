import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { DatePicker } from "./date-picker";

afterEach(cleanup);

test("팝오버에서 날짜 선택 시 해당 Date로 onChange 호출", () => {
  const onChange = vi.fn();
  render(<DatePicker value={new Date(2026, 6, 1)} onChange={onChange} />);

  // 트리거(현재 값 표시)를 클릭해 팝오버 열기
  fireEvent.click(screen.getByRole("button", { name: /2026\.07\.01/ }));
  fireEvent.click(screen.getByRole("button", { name: "2026년 7월 15일" }));

  expect(onChange).toHaveBeenCalledTimes(1);
  const d = onChange.mock.calls[0][0] as Date;
  expect(d.getFullYear()).toBe(2026);
  expect(d.getMonth()).toBe(6);
  expect(d.getDate()).toBe(15);
});

test("clear 버튼이 null로 onChange 호출", () => {
  const onChange = vi.fn();
  render(<DatePicker value={new Date(2026, 6, 1)} onChange={onChange} />);

  fireEvent.click(screen.getByRole("button", { name: "날짜 지우기" }));
  expect(onChange).toHaveBeenCalledWith(null);
});

test("값 없으면 placeholder 표시", () => {
  render(
    <DatePicker value={null} onChange={() => {}} placeholder="날짜 선택" />,
  );
  expect(screen.getByText("날짜 선택")).toBeTruthy();
});
