import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import {
  useRemoveSavedUtterance,
  useSavedUtteranceIds,
  useSaveUtterance,
} from "./saved-utterances";

const wire = {
  id: "sav_1", utterance_id: "utt_2", text: "두 문장", speaker_name: "민지", start_ms: 1000,
  created_at: "2026-08-24T01:00:00.000Z",
  meeting: { id: "mtg_1", title: "회의", recorded_at: null },
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

test("saving marks the representative utterance ID", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: { utterance_ids: [] } } as never);
  vi.spyOn(apiClient, "put").mockResolvedValue({ data: wire } as never);
  const { wrapper } = setup();
  const { result } = renderHook(() => ({ ids: useSavedUtteranceIds("mtg_1"), save: useSaveUtterance() }), { wrapper });
  await waitFor(() => expect(result.current.ids.isSuccess).toBe(true));

  await act(() => result.current.save.mutateAsync({ utteranceId: "utt_2", text: "두 문장" }));

  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(true));
  expect(get).toHaveBeenCalledWith("/saved-utterances/ids", { params: { meeting_id: "mtg_1" } });
});

test("removing a saved utterance clears its representative ID", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { utterance_ids: ["utt_2"] } } as never);
  vi.spyOn(apiClient, "delete").mockResolvedValue({ data: undefined } as never);
  const { wrapper } = setup();
  const { result } = renderHook(() => ({ ids: useSavedUtteranceIds("mtg_1"), remove: useRemoveSavedUtterance() }), { wrapper });
  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(true));

  await act(() => result.current.remove.mutateAsync("utt_2"));

  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(false));
});
