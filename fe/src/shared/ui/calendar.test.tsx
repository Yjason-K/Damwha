import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Calendar } from "./calendar";

afterEach(cleanup);

test("특정 일 클릭 시 로컬 자정 Date로 onChange 호출", () => {
  const onChange = vi.fn();
  render(<Calendar value={new Date(2026, 6, 1)} onChange={onChange} />);

  fireEvent.click(screen.getByRole("button", { name: "2026년 7월 15일" }));

  expect(onChange).toHaveBeenCalledTimes(1);
  const d = onChange.mock.calls[0][0] as Date;
  expect(d.getFullYear()).toBe(2026);
  expect(d.getMonth()).toBe(6);
  expect(d.getDate()).toBe(15);
  expect(d.getHours()).toBe(0);
  expect(d.getMinutes()).toBe(0);
});

test("다음 달 버튼으로 월 이동", () => {
  render(<Calendar value={new Date(2026, 6, 1)} onChange={() => {}} />);
  expect(screen.getByText("2026년 7월")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다음 달" }));
  expect(screen.getByText("2026년 8월")).toBeTruthy();
});
