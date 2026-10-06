import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { apiClient } from "@/shared/api/client";
import { toast } from "@/shared/ui/use-toast";
import type {
  ExtractionStatus,
  LensFilters,
  LensKind,
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

/** 회의 목록 위 요약 카드가 보여 주는 항목 수. 나머지는 `모두 보기`의 대시보드가 맡는다. */
export const LENS_OVERVIEW_LIMIT = 2;

/**
 * 회의 목록(전체·폴더)의 `최근 결정`/`진행 중인 할 일` 카드. 열린 항목의 첫 몇 개와
 * 전체 건수(`total`)만 받는다. 키를 `["lenses"]` 아래에 두지 않는 것은 완료 토글의
 * 낙관적 갱신이 그 키의 캐시를 무한 목록(`pages`) 모양으로 다루기 때문이다.
 */
export function useLensOverview(kind: LensKind, folderId?: string) {
  return useQuery({
    queryKey: ["lens-overview", kind, folderId ?? null],
    queryFn: async () => {
      const p = new URLSearchParams({
        kind,
        completion_status: "open",
        limit: String(LENS_OVERVIEW_LIMIT),
      });
      if (folderId) p.set("folder_id", folderId);
      const { data } = await apiClient.get<LensListPage>(`/lenses?${p}`);
      return data;
    },
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
      if (isDemoBlocked(_e)) return;
      toast({
        variant: "error",
        title: "완료 상태를 바꾸지 못했어요.",
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["lenses"] });
      // 완료 상태는 회의별 인사이트 패널(할 일 블록)에도 반영돼야 한다 — 그
      // 캐시(["meeting-lenses", id])를 여기서 무효화하지 않으면 대시보드에서
      // 완료 처리해도 패널은 계속 열림 상태로 보인다.
      qc.invalidateQueries({ queryKey: ["meeting-lenses"] });
      qc.invalidateQueries({ queryKey: ["lens-overview"] });
    },
  });
}

/**
 * 렌즈 추출 요청 (POST /meetings/:id/lenses/extract). 실패한 회의의 재시도이자,
 * 업로드에서 미뤄둔 회의의 최초 실행이기도 하다 — 서버는 두 경우를 같은
 * 엔드포인트로 처리하고, 이미 도는 run이 있으면 그 run을 그대로 돌려준다.
 */
export function useRetryExtraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) =>
      apiClient.post(`/meetings/${meetingId}/lenses/extract`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lens-extraction-status"] });
      qc.invalidateQueries({ queryKey: ["lenses"] });
      // 회의 패널이 추출 상태(queued)를 바로 집어 폴링을 시작하게 한다 — 이게
      // 없으면 눌러도 화면이 그대로라 아무 일도 안 난 것처럼 보인다.
      qc.invalidateQueries({ queryKey: ["meeting-lenses"] });
    },
  });
}

/** 렌즈 추출 취소 (POST /meetings/:id/lenses/cancel). 진행 중 run이 없으면 409. */
export function useCancelExtraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) =>
      apiClient.post(`/meetings/${meetingId}/lenses/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lens-extraction-status"] });
      qc.invalidateQueries({ queryKey: ["meeting-lenses"] });
    },
  });
}
