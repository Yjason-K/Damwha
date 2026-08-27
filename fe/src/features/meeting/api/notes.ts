import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";

export type MeetingNote = { body_md: string; updated_at: string };
export type SaveState = "idle" | "saving" | "saved" | "error";

const DEBOUNCE_MS = 800;

export function noteQueryKey(meetingId: string | undefined) {
  return ["meeting-note", meetingId] as const;
}

/**
 * 회의 메모 1장 (GET /meetings/:id/note). 회의 상세(`["meeting", id]`)와
 * 분리된 키를 쓰는 이유는 자동저장이다 — 상세 캐시를 800ms마다 건드리면
 * 그 캐시를 구독하는 전사 패널 전체가 함께 리렌더된다.
 */
export function useMeetingNote(
  meetingId: string | undefined,
): UseQueryResult<MeetingNote | null> {
  return useQuery({
    queryKey: noteQueryKey(meetingId),
    queryFn: async () => {
      const { data } = await apiClient.get<{ note: MeetingNote | null }>(
        `/meetings/${meetingId}/note`,
      );
      return data.note;
    },
    enabled: !!meetingId,
  });
}

/**
 * 저장 뮤테이션. 응답으로 본문을 되받지 않고 낙관적으로만 캐시를 갱신한다 —
 * 타이핑 중에 서버 응답이 본문을 덮으면 커서가 튄다.
 */
export function useSaveMeetingNote(meetingId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (bodyMd: string) => {
      const { data } = await apiClient.put<{ note: MeetingNote } | "">(
        `/meetings/${meetingId}/note`,
        { body_md: bodyMd },
      );
      // 공백 본문은 서버가 204(빈 본문)로 답한다.
      return typeof data === "string" || !data ? null : data.note;
    },
    onSuccess: (note) => {
      queryClient.setQueryData(noteQueryKey(meetingId), note);
    },
  });
}

/**
 * 로컬 draft + debounce 자동저장. 언마운트와 회의 전환 시 flush하지 않으면
 * 마지막 타이핑이 debounce 창 안에서 사라진다.
 */
export function useAutosaveNote(meetingId: string | undefined) {
  const query = useMeetingNote(meetingId);
  const mutation = useSaveMeetingNote(meetingId);
  const [draft, setDraft] = React.useState<string | null>(null);

  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<string | null>(null);
  const lastSent = React.useRef<string | null>(null);
  const { mutate } = mutation;

  const flush = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const value = pending.current;
    pending.current = null;
    if (value === null) return;
    lastSent.current = value;
    mutate(value);
  }, [mutate]);

  const change = React.useCallback(
    (next: string) => {
      setDraft(next);
      pending.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  const retry = React.useCallback(() => {
    if (lastSent.current !== null) mutate(lastSent.current);
  }, [mutate]);

  // 회의가 바뀌면 이전 회의의 draft가 새 회의에 새어 들어가면 안 된다.
  React.useEffect(() => {
    setDraft(null);
    pending.current = null;
    lastSent.current = null;
  }, [meetingId]);

  React.useEffect(() => flush, [flush]);

  const state: SaveState = mutation.isPending
    ? "saving"
    : mutation.isError
      ? "error"
      : mutation.isSuccess
        ? "saved"
        : "idle";

  return {
    body: draft ?? query.data?.body_md ?? "",
    isLoading: query.isPending,
    state,
    change,
    flush,
    retry,
  };
}
