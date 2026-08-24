import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const { apiClient } = await import("@/shared/api/client");
const { IndexRoute } = await import("@/pages/index-route");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// WireMeeting 전체 필드 (src/features/meeting/api/types.ts:27-41).
const WIRE = [
  {
    id: "m1",
    title: "기획회의",
    original_filename: null,
    audio_key: "meetings/m1/original.m4a",
    normalized_key: null,
    recorded_at: null,
    duration_ms: 60_000,
    status: "done",
    is_favorite: false,
    current_job_id: null,
    processing_version: 1,
    error: null,
    created_at: "2026-08-10T00:00:00.000Z",
  },
];

function renderIndex() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<IndexRoute />} />
          <Route path="/meetings/:meetingId" element={<div>회의 상세</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("회의가 있으면 첫 회의로 리다이렉트한다", async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: WIRE } as never);
  renderIndex();
  expect(await screen.findByText(/회의 상세/)).toBeInTheDocument();
});

test("목록이 비어 있으면 리다이렉트하지 않고 빈 상태를 렌더한다", async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: [] } as never);
  renderIndex();
  expect(await screen.findByText("아직 회의가 없어요")).toBeInTheDocument();
  expect(screen.queryByText(/회의 상세/)).not.toBeInTheDocument();
});

test("목록 조회가 실패하면 오류 상태와 재시도 버튼을 렌더한다", async () => {
  vi.mocked(apiClient.get).mockRejectedValue(new Error("boom"));
  renderIndex();
  expect(
    await screen.findByText(
      "회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
});
