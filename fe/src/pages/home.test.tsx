import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { HomePage } from "@/pages/home";

// "시작하기"가 react-router <Link>로 바뀌어 라우터 컨텍스트가 필요하다.
test("홈 페이지는 앱 타이틀과 버튼을 렌더한다", () => {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
  expect(screen.getByRole("heading", { name: "Damwha" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "시작하기" })).toBeInTheDocument();
});
