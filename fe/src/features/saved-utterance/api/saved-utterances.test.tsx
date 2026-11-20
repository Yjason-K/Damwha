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

  await act(() => result.current.remove.mutateAsync({ id: "sav_1", utteranceId: "utt_2" }));

  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(false));
  expect(apiClient.delete).toHaveBeenCalledWith("/saved-utterances/sav_1");
});

// DELETE를 붙잡아 둔 채 낙관 갱신을 본 뒤 실패시킨다 — 끝 상태만 보면 낙관 갱신이 없어도 통과한다.
function heldDelete() {
  let reject!: (error: Error) => void;
  vi.spyOn(apiClient, "delete").mockReturnValue(new Promise((_, r) => { reject = r; }) as never);
  return (error: Error) => reject(error);
}

test("a failed removal restores its representative ID", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { utterance_ids: ["utt_2"] } } as never);
  const fail = heldDelete();
  const { wrapper } = setup();
  const { result } = renderHook(() => ({ ids: useSavedUtteranceIds("mtg_1"), remove: useRemoveSavedUtterance() }), { wrapper });
  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(true));

  act(() => { result.current.remove.mutate({ id: "sav_1", utteranceId: "utt_2" }); });
  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(false));

  act(() => fail(new Error("boom")));
  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(true));
});

// 원본이 사라진 항목은 ids 캐시에 없으니 실패해도 되돌릴 것이 없다. 그사이 다른 저장이 바꾼 캐시를 덮으면 안 된다.
test("a failed orphan removal leaves saved IDs changed in the meantime", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { utterance_ids: ["utt_2"] } } as never);
  const fail = heldDelete();
  const { client, wrapper } = setup();
  const { result } = renderHook(() => ({ ids: useSavedUtteranceIds("mtg_1"), remove: useRemoveSavedUtterance() }), { wrapper });
  await waitFor(() => expect(result.current.ids.data?.has("utt_2")).toBe(true));

  act(() => { result.current.remove.mutate({ id: "sav_4", utteranceId: null }); });
  // mutationFn은 onMutate가 끝난 뒤에 불린다 — DELETE 호출을 기다려야 스냅샷 이후에 캐시를 바꾼다.
  await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith("/saved-utterances/sav_4"));
  act(() => { client.setQueryData(["saved-utterance-ids", "mtg_1"], new Set(["utt_2", "utt_9"])); });

  act(() => fail(new Error("boom")));
  await waitFor(() => expect(result.current.remove.isError).toBe(true));
  expect(result.current.ids.data?.has("utt_9")).toBe(true);
});
