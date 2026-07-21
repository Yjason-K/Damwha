import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type {
  ExtractionStatus,
  LensFilters,
  LensListPage,
} from "../model/types";

function toQuery(filters: LensFilters, cursor: string | null): string {
  const p = new URLSearchParams();
  p.set("kind", filters.kind);
  p.set("completion_status", filters.completion_status);
  if (filters.speaker_id) p.set("speaker_id", filters.speaker_id);
  if (filters.meeting_id) p.set("meeting_id", filters.meeting_id);
  if (filters.date_from) p.set("date_from", filters.date_from);
  if (filters.date_to) p.set("date_to", filters.date_to);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export function useLensList(filters: LensFilters) {
  return useInfiniteQuery({
    queryKey: ["lenses", filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const { data } = await apiClient.get<LensListPage>(
        `/lenses?${toQuery(filters, pageParam)}`,
      );
      return data;
    },
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function useLensExtractionStatus() {
  return useQuery({
    queryKey: ["lens-extraction-status"],
    queryFn: async () => {
      const { data } = await apiClient.get<ExtractionStatus>(
        "/lenses/extraction-status",
      );
      return data;
    },
    // 대시보드가 열려 있는 동안 상시 폴링 — idle/실패 상태에서 새 자동 추출도 포착.
    refetchInterval: 10_000,
  });
}

// 완료/재열기. 완료된 항목은 현재(열림) 목록에서 빠지므로 낙관적으로 제거하고,
// 실패 시 롤백한다.
export function useSetLensCompletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; done: boolean }) => {
      const path = v.done
        ? `/lenses/${v.id}/complete`
        : `/lenses/${v.id}/reopen`;
      const { data } = await apiClient.post(path);
      return data;
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["lenses"] });
      const prev = qc.getQueriesData<{
        pages: LensListPage[];
        pageParams: unknown[];
      }>({
        queryKey: ["lenses"],
      });
      qc.setQueriesData<{ pages: LensListPage[]; pageParams: unknown[] }>(
        { queryKey: ["lenses"] },
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              items: pg.items.filter((it) => it.id !== v.id),
            })),
          },
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["lenses"] }),
  });
}

export function useRetryExtraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) =>
      apiClient.post(`/meetings/${meetingId}/lenses/extract`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lens-extraction-status"] });
      qc.invalidateQueries({ queryKey: ["lenses"] });
    },
  });
}
