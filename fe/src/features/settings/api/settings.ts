import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type {
  Capabilities,
  ProcessingConfig,
  ProcessingSettingsUpdate,
} from "./types";

/** 전역 처리 설정 (서버 resolved 뷰). */
export function useProcessingSettings(): UseQueryResult<ProcessingConfig> {
  return useQuery({
    queryKey: ["processing-settings"],
    queryFn: async () => {
      const { data } = await apiClient.get<ProcessingConfig>(
        "/settings/processing",
      );
      return data;
    },
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
