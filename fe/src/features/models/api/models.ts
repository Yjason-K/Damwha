import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { ModelsView } from "./types";

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
