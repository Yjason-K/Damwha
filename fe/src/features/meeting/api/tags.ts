import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { MeetingTag } from "../model/types";
import type { WireTag, WireTagSummary } from "./types";

export type TagSummary = MeetingTag & { meetingCount: number };

/** 회의에 붙어 있는 태그 목록(이름순). 어느 회의에도 안 붙은 태그는 서버가 주지 않는다. */
export function useTags(): UseQueryResult<TagSummary[]> {
  return useQuery({
    queryKey: ["tags"],
    queryFn: async () => {
      const { data } = await apiClient.get<WireTagSummary[]>("/tags");
      return data.map((t) => ({
        id: t.id,
        name: t.name,
        meetingCount: t.meeting_count,
      }));
    },
  });
}

/** 회의의 태그를 이름 목록으로 통째로 바꾼다 (PUT /meetings/:id/tags). */
export function useSetMeetingTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; names: string[] }) => {
      const { data } = await apiClient.put<{ tags: WireTag[] }>(
        `/meetings/${vars.id}/tags`,
        { names: vars.names },
      );
      return data.tags;
    },
    // 재조회를 기다려 돌려준다 — 끝날 때까지 isPending이 남아, 화면이 낡은 목록으로 다음 PUT을 만들지 않는다.
    onSuccess: (_data, vars) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["meetings"] }),
        queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] }),
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
      ]),
  });
}
