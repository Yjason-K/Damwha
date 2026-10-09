import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import { SharedLinksSection } from "./shared-links-section";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SharedLinksSection />
    </QueryClientProvider>,
  );
const base = { scope: {}, duration_days: 7, created_at: "x", expires_at: "2026-10-15T06:00:00.000Z" };

test("공유 중·대기 중 링크를 회의 제목과 함께, 삭제된 회의는 '삭제된 회의'", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { shares: [
      { ...base, id: "shr_2", meeting_id: "mtg_1", meeting_title: "주간 회의", status: "active", url: "https://s/s/7-a#k" },
      { ...base, id: "shr_1", meeting_id: null, meeting_title: null, status: "revoke_pending", url: null },
    ] },
  } as never);
  renderIt();
  const rows = await screen.findAllByRole("listitem");
  expect(within(rows[0]).getByText("주간 회의")).toBeInTheDocument();
  expect(within(rows[0]).getByRole("button", { name: "링크 복사" })).toBeInTheDocument();
  expect(within(rows[1]).getByText("삭제된 회의")).toBeInTheDocument();
  expect(within(rows[1]).getByText("중지 대기 중")).toBeInTheDocument();
  expect(within(rows[1]).queryByRole("button", { name: "링크 복사" })).toBeNull();
});

test("비어 있으면 안내 문구", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { shares: [] } } as never);
  renderIt();
  expect(await screen.findByText("공유 중인 링크가 없어요.")).toBeInTheDocument();
});

test("공유가 꺼진 실행이면 섹션이 없다", async () => {
  const get = vi.spyOn(apiClient, "get").mockRejectedValue(new ApiError(404, "nf"));
  const { container } = renderIt();
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("지금 중지", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { shares: [{ ...base, id: "shr_2", meeting_id: "mtg_1", meeting_title: "주간 회의", status: "active", url: "u" }] },
  } as never);
  const del = vi.spyOn(apiClient, "delete").mockResolvedValue({ status: 200, data: { share: { ...base, id: "shr_2", status: "revoked", url: null } } } as never);
  renderIt();
  fireEvent.click(await screen.findByRole("button", { name: "공유 중지" }));
  await waitFor(() => expect(del).toHaveBeenCalledWith("/meetings/mtg_1/share"));
});
