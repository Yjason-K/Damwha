import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { meetingAudioUrl } from "@/features/meeting/api/mappers";
import type { SpeakerStatus, WireSpeaker } from "@/features/meeting/api/types";
import {
  SAMPLE_MAX_SECONDS,
  type SamplePlay,
} from "@/shared/lib/use-sample-player";

/** 화자 목록 아이템. */
export type SpeakerItem = {
  id: string;
  name: string;
  status: SpeakerStatus;
  createdAt: string;
  /** 목소리 미리듣기 구간. 들려줄 발화가 없으면 null — 버튼 자체를 숨긴다. */
  sample: SamplePlay | null;
};

/**
 * 미리듣기 좌표(ms) → 재생 구간(초). 화자 전용 샘플 파일이 아니라 그 화자가
 * 가장 길게 말한 회의 구간을 그대로 겨눈다. 8초를 넘으면 잘라낸다 — 목소리를
 * 알아보는 데는 그걸로 충분하고, 목록에서 발화 전체를 듣게 둘 이유가 없다.
 */
function toSample(wire: WireSpeaker): SamplePlay | null {
  const meetingId = wire.sample_meeting_id;
  const startMs = wire.sample_start_ms;
  const endMs = wire.sample_end_ms;
  if (!meetingId || startMs == null || endMs == null || endMs <= startMs) {
    return null;
  }
  const start = startMs / 1000;
  return {
    url: meetingAudioUrl(meetingId),
    start,
    end: Math.min(endMs / 1000, start + SAMPLE_MAX_SECONDS),
  };
}

function toSpeakerItem(wire: WireSpeaker): SpeakerItem {
  return {
    id: wire.id,
    name: wire.name,
    status: wire.enrollment_status,
    createdAt: wire.created_at,
    sample: toSample(wire),
  };
}

/** 화자 목록. pending 화자가 있으면 3초 간격 폴링. */
export function useSpeakers(): UseQueryResult<SpeakerItem[]> {
  return useQuery({
    queryKey: ["speakers"],
    queryFn: async () => {
      const { data } = await apiClient.get<WireSpeaker[]>("/speakers");
      return data.map(toSpeakerItem);
    },
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "pending") ? 3000 : false,
  });
}

/** 성문 등록 — 오디오 샘플로 화자 enroll. multipart 필드명 audio/name. */
export function useEnrollSpeaker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { file: File; name: string }) => {
      const form = new FormData();
      form.append("audio", vars.file);
      form.append("name", vars.name);
      const { data } = await apiClient.post<WireSpeaker>("/speakers", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return toSpeakerItem(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["speakers"] });
    },
  });
}

/** 화자 이름 변경 (PATCH /speakers/:id). provisional이면 ready로 승격. */
export function useRenameSpeaker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; name: string }) => {
      const { data } = await apiClient.patch<WireSpeaker>(
        `/speakers/${vars.id}`,
        { name: vars.name },
      );
      return toSpeakerItem(data);
    },
    onSuccess: () => {
      // 이름 변경/승격은 회의 상세의 화자 이름·상태(전사·참석자·확인 배너)와
      // 목록에 반영되므로 관련 캐시를 모두 무효화한다.
      queryClient.invalidateQueries({ queryKey: ["speakers"] });
      queryClient.invalidateQueries({ queryKey: ["meeting"] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}

/** 화자 삭제 (DELETE /speakers/:id). 진행 중 enroll이 있으면 409. */
export function useDeleteSpeaker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string }) => {
      await apiClient.delete(`/speakers/${vars.id}`);
    },
    onSuccess: () => {
      // 삭제는 회의 상세의 화자 귀속을 바꾸므로 회의 상세/목록도 무효화한다.
      queryClient.invalidateQueries({ queryKey: ["speakers"] });
      queryClient.invalidateQueries({ queryKey: ["meeting"] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}
