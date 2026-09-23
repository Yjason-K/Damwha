import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { downloadingNow } from "../lib/model-readiness";
import type {
  Capabilities,
  ProcessingConfig,
  ProcessingSettings,
  ProcessingSettingsUpdate,
} from "./types";

/** 모델을 받는 동안 이 응답을 다시 읽는 간격. 워커가 진행을 초당 1회 이하로 누른다(스펙 §6.9). */
const DOWNLOAD_POLL_MS = 3000;

/**
 * 전역 처리 설정 (서버 resolved 뷰) + 모델 준비 상태 (Phase 4 스펙 §6.9).
 *
 * 모델을 받는 **동안에만** 다시 읽는다. 상시 폴링하면 아무 일도 없는 대부분의 시간에 3초마다
 * 설정을 다시 가져오고, 안 하면 진행률이 화면에 박힌 채 멈춰 있다.
 */
export function useProcessingSettings(): UseQueryResult<ProcessingSettings> {
  return useQuery({
    queryKey: ["processing-settings"],
    queryFn: async () => {
      const { data } = await apiClient.get<ProcessingSettings>(
        "/settings/processing",
      );
      return data;
    },
    // 기준 시각은 이 데이터가 도착한 순간이다 — 화면(`ProcessingBanner`)과 같은 값을 써야
    // "화면에는 받는 중인데 폴링은 멈췄다"가 생기지 않는다.
    refetchInterval: (query) =>
      downloadingNow(query.state.data?.modelReadiness, query.state.dataUpdatedAt)
        .length > 0
        ? DOWNLOAD_POLL_MS
        : false,
  });
}

/** 전역 처리 설정 변경 — 성공 시 설정 쿼리 무효화. */
export function useUpdateProcessingSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProcessingSettingsUpdate) => {
      const { data } = await apiClient.put<ProcessingConfig>(
        "/settings/processing",
        body,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["processing-settings"] });
    },
  });
}

/** 머신 스펙 감지 결과 — 세션 중 불변이라 staleTime Infinity. */
export function useCapabilities(): UseQueryResult<Capabilities> {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: async () => {
      const { data } = await apiClient.get<Capabilities>(
        "/system/capabilities",
      );
      return data;
    },
    staleTime: Infinity,
  });
}
