import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import type { Meeting } from "@/features/meeting/model/types";
import { shareKeys } from "../api/share";
import { ShareButton } from "./share-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const meeting = {
  id: "mtg_1",
  title: "회의",
  status: "done",
  summaryStatus: "done",
} as Meeting;
const renderBtn = (
  m: Meeting = meeting,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) =>
  render(
    <QueryClientProvider client={qc}>
      <ShareButton meeting={m} />
    </QueryClientProvider>,
  );

test("공유가 없으면 '공유' 버튼", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { share: null },
  } as never);
  renderBtn();
  expect(
    await screen.findByRole("button", { name: "공유" }),
  ).toBeInTheDocument();
});

test("공유 중이면 만료일이 붙은 상태 버튼", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      share: {
        id: "shr_1",
        status: "active",
        url: "u",
        expires_at: "2026-10-15T06:00:00.000Z",
        scope: {},
        duration_days: 7,
        created_at: "x",
        meeting_id: "mtg_1",
      },
    },
  } as never);
  renderBtn();
  expect(
    await screen.findByRole("button", { name: /공유 중 · .*15일.*까지/ }),
  ).toBeInTheDocument();
});

test("공유가 꺼진 실행(404)이면 아무것도 그리지 않는다", async () => {
  const get = vi
    .spyOn(apiClient, "get")
    .mockRejectedValue(new ApiError(404, "Not Found"));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = renderBtn(meeting, qc);
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  // 응답이 "disabled"로 읽힌 뒤에도 비어 있어야 한다 — 요청 직후(로딩 중)의 빈 화면과 구분한다.
  await waitFor(() =>
    expect(qc.getQueryData(shareKeys.meeting("mtg_1"))).toBe("disabled"),
  );
  expect(container).toBeEmptyDOMElement();
});

test("처리가 끝나지 않은 회의에는 없다", () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { share: null },
  } as never);
  const { container } = renderBtn({
    ...meeting,
    status: "processing",
  } as Meeting);
  expect(container).toBeEmptyDOMElement();
  expect(get).not.toHaveBeenCalled(); // 공유 상태를 묻지도 않는다
});
