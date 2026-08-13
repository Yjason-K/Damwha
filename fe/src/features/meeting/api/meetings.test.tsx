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
  useDeleteMeeting,
  useGenerateSummary,
  useReprocessMeeting,
} from "./meetings";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const remove = vi.spyOn(qc, "removeQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate, remove };
}

test("재처리에 성공하면 회의별 렌즈 캐시도 무효화한다 — 이전 처리 버전의 항목이 남지 않도록", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    data: { meeting_id: "m1", processing_version: 2, job_id: "job_1" },
  } as never);
  const { wrapper, invalidate } = setup();
  const { result } = renderHook(() => useReprocessMeeting(), { wrapper });

  act(() => {
    result.current.mutate({ id: "m1" });
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ["meeting-lenses", "m1"],
  });
});

test("삭제에 성공하면 회의별 렌즈 캐시를 제거한다", async () => {
  vi.spyOn(apiClient, "delete").mockResolvedValue({ data: {} } as never);
  const { wrapper, remove } = setup();
  const { result } = renderHook(() => useDeleteMeeting(), { wrapper });

  act(() => {
    result.current.mutate({ id: "m1" });
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(remove).toHaveBeenCalledWith({
    queryKey: ["meeting-lenses", "m1"],
  });
});

test("요약 모델 없이 요청하면 빈 바디로 posts한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    data: { status: "queued", job_id: "job_1", processing_version: 1 },
  } as never);
  const { wrapper } = setup();
  const { result } = renderHook(() => useGenerateSummary(), { wrapper });

  act(() => {
    result.current.mutate({ id: "m1" });
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(post).toHaveBeenCalledWith("/meetings/m1/summary/generate", {});
});

test("요약 모델을 지정하면 summary_model을 바디에 담아 posts한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    data: { status: "queued", job_id: "job_1", processing_version: 1 },
  } as never);
  const { wrapper } = setup();
  const { result } = renderHook(() => useGenerateSummary(), { wrapper });

  act(() => {
    result.current.mutate({
      id: "m1",
      summary_model: "mlx-community/Qwen3.5-27B-8bit",
    });
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(post).toHaveBeenCalledWith("/meetings/m1/summary/generate", {
    summary_model: "mlx-community/Qwen3.5-27B-8bit",
  });
});

test("요약 생성이 실패하면(회의가 아직 done이 아닐 때의 409 등) 에러 토스트를 띄운다", async () => {
  vi.spyOn(apiClient, "post").mockRejectedValue(new Error("409"));
  const { wrapper } = setup();
  const { result } = renderHook(() => useGenerateSummary(), { wrapper });

  act(() => {
    result.current.mutate({ id: "m1" });
  });

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ variant: "error" }),
  );
});
