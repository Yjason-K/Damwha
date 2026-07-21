import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { useLensList, useLensExtractionStatus } from "./lenses";
import type { LensListPage, ExtractionStatus } from "../model/types";

afterEach(() => vi.restoreAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const PAGE: LensListPage = { items: [], next_cursor: null };

test("useLensList가 필터를 쿼리스트링으로 GET /lenses 호출한다", async () => {
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValue({ data: PAGE } as never);
  const { result } = renderHook(
    () =>
      useLensList({
        kind: "action",
        completion_status: "open",
        speaker_id: "spk_2",
      }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const url = get.mock.calls[0][0] as string;
  expect(url).toContain("/lenses?");
  expect(url).toContain("kind=action");
  expect(url).toContain("completion_status=open");
  expect(url).toContain("speaker_id=spk_2");
});

test("useLensExtractionStatus가 GET /lenses/extraction-status를 조회한다", async () => {
  const status: ExtractionStatus = { running: 2, failed: [] };
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValue({ data: status } as never);
  const { result } = renderHook(() => useLensExtractionStatus(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/lenses/extraction-status");
  expect(result.current.data?.running).toBe(2);
});
