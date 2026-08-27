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

type SaveNoteVars = { meetingId: string; bodyMd: string };

/**
 * 저장 뮤테이션. meetingId를 훅 인자가 아니라 변수로 받는다 — 자동저장이
 * debounce 중 회의를 전환하면, flush 시점의 mutationFn이 훅을 호출한
 * 시점의(새 회의) meetingId를 closure로 물고 있어 이전 회의의 텍스트가
 * 엉뚱한 회의로 저장돼 버린다.
 *
 * 캐시 갱신은 onSuccess가 아니라 onMutate에서 낙관적으로 한다. onSuccess로
 * 하면 두 저장이 겹칠 때 나중에 응답이 온 쪽이 무조건 이기는데, 그게 항상
 * "더 최신 입력"이라는 보장이 없다(느린 네트워크에서 이전 요청이 나중에
 * 끝날 수 있다). onMutate는 mutate() 호출 순서대로 실행되므로, 가장 최근에
 * 제출한 텍스트가 항상 마지막으로 캐시를 덮어써 순서가 뒤집히지 않는다.
 * 응답 본문 자체도 캐시에 되받아쓰지 않는다 — 타이핑 중 서버 응답이 본문을
 * 덮으면 커서가 튄다.
 */
export function useSaveMeetingNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ meetingId, bodyMd }: SaveNoteVars) => {
      const { data } = await apiClient.put<{ note: MeetingNote } | "">(
        `/meetings/${meetingId}/note`,
        { body_md: bodyMd },
      );
      // 공백 본문은 서버가 204(빈 본문)로 답한다.
      return typeof data === "string" || !data ? null : data.note;
    },
    onMutate: ({ meetingId, bodyMd }: SaveNoteVars) => {
      // 공백 본문은 서버가 행을 지우고 204로 답하므로 캐시도 null로 맞춘다.
      const note: MeetingNote | null =
        bodyMd.trim() === ""
          ? null
          : { body_md: bodyMd, updated_at: new Date().toISOString() };
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
  const mutation = useSaveMeetingNote();
  const [draft, setDraft] = React.useState<string | null>(null);

  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<string | null>(null);
  // pending이 어느 회의로 타이핑된 텍스트인지 — flush가 언제 실행되든
  // (debounce, 언마운트, 회의 전환) 그 텍스트가 속한 회의로만 보낸다.
  const pendingMeetingId = React.useRef<string | undefined>(undefined);
  const lastSent = React.useRef<string | null>(null);
  const { mutate } = mutation;

  const flush = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const value = pending.current;
    const targetMeetingId = pendingMeetingId.current;
    pending.current = null;
    if (value === null || targetMeetingId === undefined) return;
    lastSent.current = value;
    mutate({ meetingId: targetMeetingId, bodyMd: value });
  }, [mutate]);

  const change = React.useCallback(
    (next: string) => {
      setDraft(next);
      pending.current = next;
      pendingMeetingId.current = meetingId;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, DEBOUNCE_MS);
    },
    [flush, meetingId],
  );

  const retry = React.useCallback(() => {
    // 저장 실패 후 사용자가 다시 입력했다면 pending(더 최신)을 우선한다.
    // 그대로 lastSent만 재전송하면 실패 이후 편집분이 사라진다.
    const value = pending.current ?? lastSent.current;
    const targetMeetingId = pendingMeetingId.current ?? meetingId;
    if (value === null || targetMeetingId === undefined) return;
    lastSent.current = value;
    mutate({ meetingId: targetMeetingId, bodyMd: value });
  }, [mutate, meetingId]);

  // 회의가 바뀌면 이전 회의의 draft가 새 회의로 새어 들어가면 안 된다.
  // setState는 effect가 아니라 렌더 중에 조정한다 — React가 권장하는 형태이고
  // (react-hooks/set-state-in-effect), 아래 effect의 flush는 ref만 읽으므로
  // 이 조정에 영향받지 않는다.
  const [prevMeetingId, setPrevMeetingId] = React.useState(meetingId);
  if (prevMeetingId !== meetingId) {
    setPrevMeetingId(meetingId);
    setDraft(null);
  }

  // 회의가 바뀌면 이전 회의의 대기 중인 입력을 먼저 flush한다(그래야
  // pendingMeetingId가 아직 이전 회의를 가리키는 시점에 보내진다). 그 다음
  // ref를 새 회의 기준으로 초기화한다.
  React.useEffect(() => {
    flush();
    pending.current = null;
    pendingMeetingId.current = undefined;
    lastSent.current = null;
  }, [meetingId, flush]);

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
