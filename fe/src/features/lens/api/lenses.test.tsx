import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";

vi.mock("@/shared/ui/use-toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/use-toast")>();
  return { ...actual, toast: vi.fn() };
});

import { toast } from "@/shared/ui/use-toast";
import {
  useLensList,
  useLensExtractionStatus,
  useSetLensCompletion,
} from "./lenses";
import type {
  LensListPage,
  ExtractionStatus,
  LensWireItem,
} from "../model/types";

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

test("useSetLensCompletion이 실패하면 캐시를 롤백하고 토스트를 띄운다", async () => {
  const item: LensWireItem = {
    id: "lens_1",
    kind: "action",
    text: "액션아이템",
    source: "ai",
    user_modified: false,
    completion_status: "open",
    lifecycle_status: "active",
    meeting_id: "m1",
    assignee_speaker_id: null,
    due_at: null,
    created_at: "2026-06-21T09:00:00.000Z",
    updated_at: "2026-06-21T09:00:00.000Z",
    meeting: { id: "m1", title: null },
    evidence: [],
  };
  const page: LensListPage = { items: [item], next_cursor: null };
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: page } as never);
  const post = vi
    .spyOn(apiClient, "post")
    .mockRejectedValue(new Error("network error"));

  const { result } = renderHook(
    () => ({
      list: useLensList({ kind: "action", completion_status: "open" }),
      completion: useSetLensCompletion(),
    }),
    { wrapper },
  );

  await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
  expect(result.current.list.data?.pages[0]?.items).toHaveLength(1);

  act(() => {
    result.current.completion.mutate({ id: "lens_1", done: true });
  });

  await waitFor(() => expect(result.current.completion.isError).toBe(true));

  // 실패 → 롤백: 항목이 되돌아온다.
  expect(result.current.list.data?.pages[0]?.items).toHaveLength(1);
  expect(result.current.list.data?.pages[0]?.items[0]?.id).toBe("lens_1");

  expect(post).toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ variant: "error" }),
  );
});

test("useSetLensCompletion이 성공하면 회의별 렌즈 캐시도 무효화한다 — 대시보드에서 완료해도 회의 패널이 갱신되도록", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const w = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  const { result } = renderHook(() => useSetLensCompletion(), { wrapper: w });

  act(() => {
    result.current.mutate({ id: "lens_1", done: true });
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["lenses"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meeting-lenses"] });
});
