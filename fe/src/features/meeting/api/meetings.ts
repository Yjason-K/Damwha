import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { ProcessingOverride } from "@/features/settings/api/types";
import type { Meeting, MeetingStatus, MeetingSummary } from "../model/types";
import { toMeetingDetail, toMeetingSummary } from "./mappers";
import type {
  MeetingStatusResponse,
  ResolveClusterRequest,
  ResolveClusterResponse,
  WireMeeting,
  WireMeetingDetail,
} from "./types";

export { meetingAudioUrl } from "./mappers";

const isActive = (status: MeetingStatus) =>
  status === "uploaded" || status === "processing";

/** 회의 목록. 처리 중인 회의가 있으면 3초 간격 폴링. */
export function useMeetings(): UseQueryResult<MeetingSummary[]> {
  return useQuery({
    queryKey: ["meetings"],
    queryFn: async () => {
      const { data } = await apiClient.get<WireMeeting[]>("/meetings");
      return data.map(toMeetingSummary);
    },
    refetchInterval: (query) =>
      query.state.data?.some((m) => isActive(m.status)) ? 3000 : false,
  });
}

/** 회의 상세(발화 포함). status가 done/failed가 아니면 2.5초 간격 폴링. */
export function useMeeting(id: string | undefined): UseQueryResult<Meeting> {
  return useQuery({
    queryKey: ["meeting", id],
    queryFn: async () => {
      const { data } = await apiClient.get<WireMeetingDetail>(
        `/meetings/${id}`,
      );
      return toMeetingDetail(data);
    },
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status) return false;
      return status === "done" || status === "failed" ? false : 2500;
    },
  });
}

/** 회의 처리 상태(stage/progress). enabled로 폴링 여부 제어, 2초 간격. */
export function useMeetingStatus(
  id: string | undefined,
  enabled: boolean,
): UseQueryResult<MeetingStatusResponse> {
  return useQuery({
    queryKey: ["meeting-status", id],
    queryFn: async () => {
      const { data } = await apiClient.get<MeetingStatusResponse>(
        `/meetings/${id}/status`,
      );
      return data;
    },
    enabled: enabled && !!id,
    refetchInterval: 2000,
  });
}

/** 오디오 업로드 → 처리 큐 등록. multipart 필드명 audio/title/recorded_at. */
export function useUploadMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      file: File;
      title?: string;
      recordedAt?: string;
      processing?: ProcessingOverride;
    }) => {
      const form = new FormData();
      form.append("audio", vars.file);
      if (vars.title) form.append("title", vars.title);
      if (vars.recordedAt) form.append("recorded_at", vars.recordedAt);
      if (vars.processing)
        form.append("processing", JSON.stringify(vars.processing));
      const { data } = await apiClient.post<WireMeeting>("/meetings", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return toMeetingSummary(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}

/** 즐겨찾기 토글 — fav면 PUT, 아니면 DELETE. */
export function useToggleFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; fav: boolean }) => {
      const path = `/meetings/${vars.id}/favorite`;
      const { data } = vars.fav
        ? await apiClient.put<WireMeeting>(path)
        : await apiClient.delete<WireMeeting>(path);
      return toMeetingSummary(data);
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
    },
  });
}

/** 회의 제목 변경 (PATCH /meetings/:id). */
export function useRenameMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; title: string }) => {
      const { data } = await apiClient.patch<WireMeeting>(
        `/meetings/${vars.id}`,
        { title: vars.title },
      );
      return toMeetingSummary(data);
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
    },
  });
}

/** 회의 삭제 (DELETE /meetings/:id). */
export function useDeleteMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string }) => {
      await apiClient.delete(`/meetings/${vars.id}`);
    },
    onSuccess: (_data, vars) => {
      // 삭제된 회의의 상세/상태 캐시를 제거해 렌더 잔존과 404 폴링 루프를 막고,
      // 목록은 무효화해 다시 가져온다.
      queryClient.removeQueries({ queryKey: ["meeting", vars.id] });
      queryClient.removeQueries({ queryKey: ["meeting-status", vars.id] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}

/** 재처리 (POST /meetings/:id/reprocess). done/failed에서만 허용(그 외 409). */
export function useReprocessMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      processing?: ProcessingOverride;
    }) => {
      const { data } = await apiClient.post<{
        meeting_id: string;
        processing_version: number;
        job_id: string;
      }>(
        `/meetings/${vars.id}/reprocess`,
        vars.processing ? { processing: vars.processing } : {},
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      queryClient.invalidateQueries({ queryKey: ["meeting-status", vars.id] });
    },
  });
}

/** 클러스터를 화자에 연결/병합 (resolve). body는 be-contracts.md 계약 그대로. */
export function useResolveCluster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      meetingId: string;
      clusterId: string;
      body: ResolveClusterRequest;
    }) => {
      const { data } = await apiClient.post<ResolveClusterResponse>(
        `/meetings/${vars.meetingId}/clusters/${vars.clusterId}/resolve`,
        vars.body,
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.meetingId] });
      queryClient.invalidateQueries({ queryKey: ["speakers"] });
    },
  });
}
