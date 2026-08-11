import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { toast } from "@/shared/ui/use-toast";
import type { ProcessingOverride } from "@/features/settings/api/types";
import type { Meeting, MeetingStatus, MeetingSummary } from "../model/types";
import { toMeetingDetail, toMeetingSummary } from "./mappers";
import type {
  MeetingStatusResponse,
  ResolveClusterRequest,
  ResolveClusterResponse,
  SummaryStatus,
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
      // 목록 캐시에서 삭제된 회의를 즉시 빼낸다. 무효화만 하면 재조회가 끝나기
      // 전까지 낡은 목록이 그대로 읽히는데(캐시가 있으니 isLoading도 false),
      // 삭제 후 `/`로 보내는 경로에서 IndexRoute가 그 낡은 목록의 [0] —
      // 즉 방금 삭제한 회의 — 로 되돌려 404 막다른 길을 만든다. 레일에서 삭제된
      // 행이 잠깐 남는 깜빡임도 함께 사라진다.
      queryClient.setQueryData<MeetingSummary[]>(["meetings"], (old) =>
        old?.filter((m) => m.id !== vars.id),
      );
      // 삭제된 회의의 상세/상태/렌즈 캐시를 제거해 렌더 잔존과 404 폴링 루프를
      // 막고, 목록은 무효화해 다시 가져온다.
      queryClient.removeQueries({ queryKey: ["meeting", vars.id] });
      queryClient.removeQueries({ queryKey: ["meeting-status", vars.id] });
      queryClient.removeQueries({ queryKey: ["meeting-lenses", vars.id] });
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
      // 재처리는 이전 처리 버전의 렌즈 항목을 무효화한다 — 새 결과가 나올
      // 때까지 이전 버전의 항목이 패널에 남지 않도록 함께 무효화한다.
      queryClient.invalidateQueries({
        queryKey: ["meeting-lenses", vars.id],
      });
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

/** 대화 요약 생성/재생성 (POST /meetings/:id/summary/generate). done에서만 허용(그 외 409). */
export function useGenerateSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string }) => {
      const { data } = await apiClient.post<{
        status: string;
        job_id: string | null;
        processing_version: number;
      }>(`/meetings/${vars.id}/summary/generate`);
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
      queryClient.invalidateQueries({ queryKey: ["meeting-status", vars.id] });
    },
    onError: () => {
      toast({
        variant: "error",
        title: "요약을 만들지 못했어요.",
      });
    },
  });
}

/**
 * 요약 상태 동기화 — 상세 응답은 회의가 done이면 더 폴링되지 않는데, 요약 잡은
 * 그 뒤에 돈다. 가벼운 상태 엔드포인트가 알려준 summary_status가 상세 캐시의
 * 값과 어긋나면 상세를 한 번만 다시 가져온다. 갱신 후 두 값이 같아지므로
 * 반복 무효화로 이어지지 않는다.
 *
 * 회의별 렌즈(액션 아이템/결정)도 요약과 같은 처리-후 작업 묶음의 산출물이라
 * 별도 상태 신호가 없다 — 요약 상태가 바뀌는 시점에 함께 무효화해 얹혀간다.
 */
export function useSyncSummaryStatus(
  meetingId: string | undefined,
  detailStatus: SummaryStatus | null | undefined,
  polledStatus: SummaryStatus | null | undefined,
) {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!meetingId || polledStatus === undefined) return;
    if (polledStatus === detailStatus) return;
    queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
    queryClient.invalidateQueries({
      queryKey: ["meeting-lenses", meetingId],
    });
  }, [meetingId, detailStatus, polledStatus, queryClient]);
}
