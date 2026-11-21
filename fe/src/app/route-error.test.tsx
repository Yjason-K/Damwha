import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { routes } from "@/app/router";

// 셸 자체가 렌더 중 깨지는 경우(#98) — 루트 경계가 셸 없이 전체 화면으로 잡는다.
vi.mock("@/app/app-shell", () => ({
  AppShell: () => {
    throw new Error("shell boom");
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("셸이 깨지면 기본 오류 화면 대신 앱의 오류 화면을 그린다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const router = createMemoryRouter(routes, { initialEntries: ["/meetings"] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "화면을 그리지 못했어요",
  );
  expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  expect(screen.queryByText(/shell boom/)).toBeNull();
  expect(screen.queryByRole("button", { name: "녹음 종료" })).toBeNull();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
});
