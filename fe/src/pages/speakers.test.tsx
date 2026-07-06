import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import type { WireSpeaker } from "@/features/meeting/api/types";

/**
 * 화자 관리 페이지 통합 테스트 — 목킹한 `apiClient`로 목록 렌더와 등록 다이얼로그
 * 열기를 검증한다. 규약: vitest globals 없음 + 수동 afterEach(cleanup).
 */

const fx = vi.hoisted(() => {
  const speakers: WireSpeaker[] = [
    {
      id: "sp_1",
      name: "김영재",
      enrollment_status: "ready",
      current_job_id: null,
      enrollment_error: null,
      created_at: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "sp_2",
      name: "이수민",
      enrollment_status: "provisional",
      current_job_id: null,
      enrollment_error: null,
      created_at: "2026-06-10T00:00:00.000Z",
    },
  ];
  return { speakers };
});

vi.mock("@/shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/client")>(
    "@/shared/api/client",
  );
  return {
    ...actual,
    apiClient: {
      get: vi.fn((url: string) => {
        if (url === "/speakers") return Promise.resolve({ data: fx.speakers });
        return Promise.reject(new Error(`unhandled GET ${url}`));
      }),
      post: vi.fn(() => Promise.resolve({ data: fx.speakers[0] })),
      patch: vi.fn(() => Promise.resolve({ data: fx.speakers[0] })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

const { SpeakersPage } = await import("@/pages/speakers");

afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SpeakersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("화자 목록을 렌더한다", async () => {
  renderPage();
  expect(await screen.findByText("김영재")).toBeInTheDocument();
  expect(screen.getByText("이수민")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { level: 1, name: "화자 관리" }),
  ).toBeInTheDocument();
});

test("화자 등록 버튼으로 등록 다이얼로그를 연다", async () => {
  renderPage();
  await screen.findByText("김영재");
  fireEvent.click(screen.getByRole("button", { name: "화자 등록" }));
  expect(
    await screen.findByText(
      "화자의 목소리 샘플을 등록하면 회의에서 자동으로 식별할 수 있어요.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "등록" })).toBeInTheDocument();
});
