import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { SpeakerCountField } from "./speaker-count-field";

afterEach(cleanup);

test("빈 값이면 undefined, 최소/최대 입력이 각각 onChange로 전달된다", () => {
  const onChange = vi.fn();
  render(<SpeakerCountField value={undefined} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("최소 화자 수"), {
    target: { value: "2" },
  });
  expect(onChange).toHaveBeenLastCalledWith({ min: 2 });
});

test("최대만 채워도 되고, 지우면 다시 undefined", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <SpeakerCountField value={undefined} onChange={onChange} />,
  );
  fireEvent.change(screen.getByLabelText("최대 화자 수"), {
    target: { value: "5" },
  });
  expect(onChange).toHaveBeenLastCalledWith({ max: 5 });
  rerender(<SpeakerCountField value={{ max: 5 }} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("최대 화자 수"), {
    target: { value: "" },
  });
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});

test("최소 > 최대면 오류를 보이고 invalid로 표시한다", () => {
  render(<SpeakerCountField value={{ min: 6, max: 3 }} onChange={() => {}} />);
  expect(screen.getByText(/최소가 최대보다/)).toBeTruthy();
  expect(
    screen.getByLabelText("최소 화자 수").getAttribute("aria-invalid"),
  ).toBe("true");
});
