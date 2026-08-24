import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { useSyncSummaryStatus } from "./meetings";

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}

describe("useSyncSummaryStatus", () => {
  it("상태가 같으면 아무것도 하지 않는다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", "running", "running"), {
      wrapper,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("폴링이 아직 값을 못 받았으면 아무것도 하지 않는다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", "running", undefined), {
      wrapper,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("queued에서 done으로 바뀌면 상세를 무효화한다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", "queued", "done"), {
      wrapper,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meeting", "mtg_1"] });
  });

  it("상태가 바뀌면 회의별 렌즈 캐시도 함께 무효화한다 — 같은 처리-후 작업 묶음의 산출물이라 별도 신호가 없다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", "queued", "done"), {
      wrapper,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["meeting-lenses", "mtg_1"],
    });
  });

  it("요약이 없다가 생기면(null → queued) 상세를 무효화한다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus("mtg_1", null, "queued"), {
      wrapper,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meeting", "mtg_1"] });
  });

  it("회의 id가 없으면 아무것도 하지 않는다", () => {
    const { wrapper, invalidate } = setup();
    renderHook(() => useSyncSummaryStatus(undefined, null, "done"), {
      wrapper,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
