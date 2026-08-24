import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { SavedUtterancesPage } from "./saved-utterances";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Probe() { return <span>경로: {useLocation().pathname}{useLocation().search}</span>; }

function renderPage(item: Record<string, unknown>) {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { items: [item], next_cursor: null } } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><Probe /><SavedUtterancesPage /></MemoryRouter></QueryClientProvider>);
}

test("saved card shows context and jumps with the existing utterance URL", async () => {
  renderPage({ id: "sav_1", utterance_id: "utt_4", text: "결정은 다음 주에 합니다.", speaker_name: "민지", start_ms: 73_000, created_at: "2026-08-24T00:00:00Z", meeting: { id: "mtg_2", title: "주간 회의", recorded_at: null } });
  expect(await screen.findByText("결정은 다음 주에 합니다.")).toBeInTheDocument();
  expect(screen.getByText("민지 · 01:13")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "원문으로 이동" }));
  expect(screen.getByText("경로: /meetings/mtg_2?u=utt_4")).toBeInTheDocument();
});

test("historical snapshot remains visible but cannot jump", async () => {
  renderPage({ id: "sav_1", utterance_id: null, text: "남아 있는 기록", speaker_name: null, start_ms: 0, created_at: "2026-08-24T00:00:00Z", meeting: { id: "mtg_2", title: null, recorded_at: null } });
  expect(await screen.findByText("남아 있는 기록")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "원문으로 이동" })).toBeDisabled();
});
