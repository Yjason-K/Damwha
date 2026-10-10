import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import { useDeleteMeeting } from "@/features/meeting/api/meetings";
import { shareErrorKey, shareKeys, useCreateShare, useMeetingShare, useStopShare } from "./share";

afterEach(() => vi.restoreAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VIEW = {
  id: "shr_1", meeting_id: "mtg_1", status: "active", url: "https://s/s/7-x#k",
  expires_at: "2026-10-16T00:00:00.000Z", scope: { summary: true, lenses: true, transcript: false, note: false, anonymize: false },
  duration_days: 7, created_at: "2026-10-09T00:00:00.000Z",
};

test("useMeetingShare — 공유가 있으면 그 view", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { share: VIEW } } as never);
  const { result } = renderHook(() => useMeetingShare("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual(VIEW);
});

test("useMeetingShare — 404면 'disabled' (공유가 꺼진 실행)", async () => {
  vi.spyOn(apiClient, "get").mockRejectedValue(new ApiError(404, "Not Found"));
  const { result } = renderHook(() => useMeetingShare("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBe("disabled");
});

test("useCreateShare — 동의 버전과 책임 확인을 실어 보낸다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { share: VIEW } } as never);
  const { result } = renderHook(() => useCreateShare(), { wrapper });
  await result.current.mutateAsync({
    meetingId: "mtg_1", scope: { ...VIEW.scope, transcript: true }, durationDays: 30, transcriptAck: true, uiLanguage: "ko",
  });
  expect(post).toHaveBeenCalledWith("/meetings/mtg_1/share", {
    scope: { ...VIEW.scope, transcript: true }, duration_days: 30, consent_version: 1, transcript_ack: true, ui_language: "ko",
  });
});

test("useStopShare — 202면 pending", async () => {
  vi.spyOn(apiClient, "delete").mockResolvedValue({ status: 202, data: { share: { ...VIEW, status: "revoke_pending", url: null } } } as never);
  const { result } = renderHook(() => useStopShare(), { wrapper });
  expect((await result.current.mutateAsync({ meetingId: "mtg_1" })).pending).toBe(true);
});

test("shareErrorKey — 아는 code는 그 키, 아니면 generic", () => {
  expect(shareErrorKey(new ApiError(409, "x", "SHARE_IN_PROGRESS"))).toBe("errors.SHARE_IN_PROGRESS");
  expect(shareErrorKey(new ApiError(500, "x", "SOMETHING"))).toBe("errors.generic");
  expect(shareErrorKey(new Error("x"))).toBe("errors.generic");
});

test("useDeleteMeeting — 공유 철회 결과를 돌려주고 그 회의의 공유 캐시를 지운다", async () => {
  const result_ = { share_revoke: "pending", share_expires_at: "2026-10-16T00:00:00.000Z" };
  vi.spyOn(apiClient, "delete").mockResolvedValue({ status: 200, data: result_ } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(shareKeys.meeting("mtg_1"), VIEW);
  qc.setQueryData(shareKeys.meeting("mtg_2"), VIEW);
  const w = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useDeleteMeeting(), { wrapper: w });
  expect(await result.current.mutateAsync({ id: "mtg_1" })).toEqual(result_);
  expect(qc.getQueryData(shareKeys.meeting("mtg_1"))).toBeUndefined();
  expect(qc.getQueryData(shareKeys.meeting("mtg_2"))).toEqual(VIEW);
});
