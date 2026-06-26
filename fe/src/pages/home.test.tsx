import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { HomePage } from "@/pages/home";

test("홈 페이지는 앱 타이틀과 버튼을 렌더한다", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: "Damwha" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "시작하기" }),
  ).toBeInTheDocument();
});
