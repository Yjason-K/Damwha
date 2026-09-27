import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { ModelKey, ModelsView } from "./types";

export const MODELS_QUERY_KEY = ["models"] as const;

/** 받는 중이거나 inventory 갱신을 기다리는 동안(`pending`) 다시 읽는 간격. */
const PENDING_POLL_MS = 3000;

/**
 * 모델별 사용·받음·용량 (모델 다운로드 관리 스펙 §5.1·§6.3).
 *
 * 다시 읽을지는 **서버가** 정한다(`pending`) — 멈춤 판정과 "받기는 끝났는데 inventory가 아직
 * 안 바뀜" 구간을 fe가 다시 갖지 않는다.
 */
export function useModels(): UseQueryResult<ModelsView> {
  return useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await apiClient.get<ModelsView>("/models");
      return data;
    },
    refetchInterval: (query) => (query.state.data?.pending ? PENDING_POLL_MS : false),
  });
}

/** 요청 본문 — backend가 null이면 필드 자체를 뺀다(스펙 §5.2, 논리 키는 role:name:backend). */
function body(k: ModelKey) {
  return k.backend === null
    ? { role: k.role, name: k.name }
    : { role: k.role, name: k.name, backend: k.backend };
}

/** 받기·삭제·취소 공통: 성공하면 `["models"]`을 무효화해 새 job·상태를 즉시 반영한다. */
function useModelMutation<T>(fn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY }),
  });
}

export const useDownloadModel = () =>
  useModelMutation((k: ModelKey) => apiClient.post("/models/download", body(k)));
export const useDeleteModel = () =>
  useModelMutation((k: ModelKey) => apiClient.post("/models/delete", body(k)));
export const useCancelModelJob = () =>
  useModelMutation((jobId: string) => apiClient.post("/models/cancel", { jobId }));
