import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { TimePicker } from "./time-picker";

afterEach(cleanup);

/** 팝오버를 열고 특정 열(시/분)의 옵션 버튼을 집는다. */
function openAndGetOption(
  triggerName: RegExp | string,
  column: string,
  label: string,
) {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  const list = screen.getByRole("listbox", { name: column });
  return screen
    .getAllByRole("option", { name: label })
    .find((el) => list.contains(el))!;
}

test("시를 고르면 분은 유지한 채 HH:MM으로 onChange", () => {
  const onChange = vi.fn();
  render(<TimePicker value="09:30" onChange={onChange} />);

  fireEvent.click(openAndGetOption(/09:30/, "시", "14"));
  expect(onChange).toHaveBeenCalledWith("14:30");
});

test("분을 고르면 시는 유지한다", () => {
  const onChange = vi.fn();
  render(<TimePicker value="09:30" onChange={onChange} />);

  fireEvent.click(openAndGetOption(/09:30/, "분", "45"));
  expect(onChange).toHaveBeenCalledWith("09:45");
});

test("값이 없을 때 시만 고르면 분은 00으로 채운다", () => {
  const onChange = vi.fn();
  render(<TimePicker value="" onChange={onChange} />);

  fireEvent.click(openAndGetOption("--:--", "시", "07"));
  expect(onChange).toHaveBeenCalledWith("07:00");
});

test("격자 밖의 분도 목록에 끼워 넣어 선택 상태를 유지한다", () => {
  render(<TimePicker value="09:37" onChange={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: /09:37/ }));
  const minutes = screen.getByRole("listbox", { name: "분" });
  const selected = screen
    .getAllByRole("option", { name: "37" })
    .find((el) => minutes.contains(el))!;
  expect(selected.getAttribute("aria-selected")).toBe("true");
});

test("clear 버튼이 빈 문자열로 onChange 호출", () => {
  const onChange = vi.fn();
  render(<TimePicker value="09:30" onChange={onChange} />);

  fireEvent.click(screen.getByRole("button", { name: "시각 지우기" }));
  expect(onChange).toHaveBeenCalledWith("");
});

test("값 없으면 placeholder 표시, clear 버튼 없음", () => {
  render(<TimePicker value="" onChange={() => {}} />);

  expect(screen.getByText("--:--")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "시각 지우기" })).toBeNull();
});
