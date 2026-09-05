import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, test, vi } from "vitest";

/**
 * 데모 빌드에서는 "녹음 시작" 버튼이 보이지 않아야 한다 — 데모는 읽기 전용이라
 * 엔드포인트가 늘 거절하므로, 항상 실패하는 버튼을 보여주는 것보다 숨기는 쪽을
 * 택했다(left-nav.tsx의 `env.demoMode ? null : <RecordItem .../>`).
 * env 강제 방식은 upload-dialog.demo.test.tsx와 같다.
 */

vi.mock("@/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/shared/config/env")>();
  return {
    env: {
      ...mod.env,
      demoMode: true,
    },
  };
});

vi.mock("@/shared/api/client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn() },
}));

vi.mock("@/features/meeting/ui/upload-dialog", () => ({
  UploadDialog: () => null,
}));

vi.mock("@/features/meeting/ui/live-start-dialog", () => ({
  LiveStartDialog: () => null,
}));

vi.mock("@/features/demo/ui/tour-launch-button", () => ({
  TourLaunchButton: () => <button type="button">둘러보기 흉내</button>,
}));

const { LeftNav } = await import("@/features/meeting/ui/left-nav");

test("데모 빌드에서는 '녹음 시작' 버튼이 보이지 않는다", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="*"
            element={
              <LeftNav
                filter="all"
                onFilter={() => {}}
                onOpenSearch={() => {}}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    screen.getByRole("button", { name: /새 회의 기록하기/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "녹음 시작" }),
  ).not.toBeInTheDocument();
});
