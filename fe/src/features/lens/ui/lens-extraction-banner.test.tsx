import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { LensExtractionBanner } from "./lens-extraction-banner";

afterEach(() => vi.restoreAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("실패 회의에 재시도 버튼을 렌더하고 클릭 시 extract를 호출한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      running: 0,
      failed: [{ meeting_id: "mtg_7", title: "주간 스크럼" }],
    },
  } as never);
  const post = vi
    .spyOn(apiClient, "post")
    .mockResolvedValue({ data: {} } as never);

  render(<LensExtractionBanner />, { wrapper });
  const btn = await screen.findByRole("button", { name: /재시도/ });
  fireEvent.click(btn);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/meetings/mtg_7/lenses/extract"),
  );
});

test("진행중도 실패도 없으면 아무것도 렌더하지 않는다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { running: 0, failed: [] },
  } as never);
  const { container } = render(<LensExtractionBanner />, { wrapper });
  await screen.findByTestId("banner-root").catch(() => null);
  expect(container.querySelector("[data-testid='banner-root']")).toBeNull();
});
