import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";

import type { SavedUtterance, SavedUtterancePage, SavedUtteranceWire } from "./types";

function mapSaved(value: SavedUtteranceWire): SavedUtterance {
  return {
    id: value.id,
    utteranceId: value.utterance_id,
    text: value.text,
    speakerId: value.speaker_id,
    speakerName: value.speaker_name,
    startMs: value.start_ms,
    createdAt: value.created_at,
    meeting: { id: value.meeting.id, title: value.meeting.title, recordedAt: value.meeting.recorded_at },
  };
}

// 회의 단위로 묻는다. 발화 id를 나열해 묻던 방식은 전사가 100개를 넘는 순간
// 서버가 400을 돌려줬고(실제 회의는 수백~수천 발화다) 애초에 id 수천 개가
// 쿼리 스트링에 들어갔다.
export function useSavedUtteranceIds(meetingId: string) {
  return useQuery({
    queryKey: ["saved-utterance-ids", meetingId],
    queryFn: async () => {
      const { data } = await apiClient.get<{ utterance_ids: string[] }>("/saved-utterances/ids", {
        params: { meeting_id: meetingId },
      });
      return new Set(data.utterance_ids ?? []);
    },
  });
}

export function useSavedUtterances() {
  return useInfiniteQuery({
    queryKey: ["saved-utterances"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      const { data } = await apiClient.get<{ items: SavedUtteranceWire[]; next_cursor: string | null }>(
        `/saved-utterances${params.size ? `?${params}` : ""}`,
      );
      return { items: data.items.map(mapSaved), nextCursor: data.next_cursor } satisfies SavedUtterancePage;
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

function updateSavedIds(queryClient: ReturnType<typeof useQueryClient>, id: string, saved: boolean) {
  queryClient.setQueriesData<Set<string>>({ queryKey: ["saved-utterance-ids"] }, (old) => {
    if (!old) return old;
    const next = new Set(old);
    if (saved) next.add(id); else next.delete(id);
    return next;
  });
}

export function useSaveUtterance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: { utteranceId: string; text: string }) => {
      const { data } = await apiClient.put<SavedUtteranceWire>(`/saved-utterances/${value.utteranceId}`, { text_snapshot: value.text });
      return mapSaved(data);
    },
    onMutate: async ({ utteranceId }) => {
      await queryClient.cancelQueries({ queryKey: ["saved-utterance-ids"] });
      const previous = queryClient.getQueriesData<Set<string>>({ queryKey: ["saved-utterance-ids"] });
      updateSavedIds(queryClient, utteranceId, true);
      return { previous };
    },
    onError: (_error, _value, context) => context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["saved-utterances"] }),
  });
}

export function useRemoveSavedUtterance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (utteranceId: string) => { await apiClient.delete(`/saved-utterances/${utteranceId}`); },
    onMutate: async (utteranceId) => {
      await queryClient.cancelQueries({ queryKey: ["saved-utterance-ids"] });
      const previous = queryClient.getQueriesData<Set<string>>({ queryKey: ["saved-utterance-ids"] });
      updateSavedIds(queryClient, utteranceId, false);
      return { previous };
    },
    onError: (_error, _value, context) => context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["saved-utterances"] }),
  });
}
