import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

/**
 * LeftNav가 스스로 하는 이동(업로드 완료 → 새 회의 경로)만 좁게 검증한다.
 * 업로드 자체는 NewMeetingDialog 목으로 대체해 흉내 낸다.
 */

vi.mock("@/shared/api/client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn() },
}));

vi.mock("@/features/meeting/ui/new-meeting-dialog", () => ({
  NewMeetingDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (id: string) => void;
  }) =>
    open ? (
      <>
        <button type="button" onClick={() => onCreated("m9")}>
          업로드 완료 흉내
        </button>
        <button type="button" onClick={() => onCreated("m8")}>
          녹음 시작 흉내
        </button>
      </>
    ) : null,
}));

const { LeftNav } = await import("@/features/meeting/ui/left-nav");

afterEach(cleanup);

function Probe() {
  return <span>경로: {useLocation().pathname}</span>;
}

test("업로드가 끝나면 새 회의 경로로 이동한다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
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
  fireEvent.click(screen.getByRole("button", { name: /새 회의 기록하기/ }));
  fireEvent.click(screen.getByRole("button", { name: "업로드 완료 흉내" }));
  expect(await screen.findByText("경로: /meetings/m9")).toBeInTheDocument();
});

test("통합 다이얼로그에서 녹음을 시작하면 새 회의 경로로 이동한다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
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
    screen.queryByRole("button", { name: "녹음 시작" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /새 회의 기록하기/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "녹음 시작 흉내" }),
  );
  expect(await screen.findByText("경로: /meetings/m8")).toBeInTheDocument();
});

test("녹음 중인 회의에는 '녹음 중' 뱃지가 붙는다", async () => {
  const { apiClient } = await import("@/shared/api/client");
  (apiClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    data: [
      {
        id: "m1",
        title: "지금 회의",
        original_filename: null,
        audio_key: "k",
        normalized_key: null,
        recorded_at: "2026-09-05T10:00:00.000Z",
        duration_ms: null,
        status: "recording",
        is_favorite: false,
        current_job_id: "job_1",
        processing_version: 0,
        error: null,
        created_at: "2026-09-05T10:00:00.000Z",
      },
    ],
  });
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
  expect(await screen.findByText("녹음 중")).toBeInTheDocument();
});
