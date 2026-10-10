import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { SHARE_CONSENT_VERSION, type ShareDurationDays, type UiLanguage } from "@damwha/contracts";
import type { SharePayloadV1, ShareScope } from "@damwha/share-format";
import { ApiError, apiClient, isApiError } from "@/shared/api/client";
import { env } from "@/shared/config/env";

export type { ShareScope };
export type ShareStatus = "creating" | "active" | "revoke_pending" | "revoked" | "expired";
export type ShareView = {
  id: string;
  meeting_id: string | null;
  status: ShareStatus;
  url: string | null;
  expires_at: string | null;
  scope: ShareScope;
  duration_days: number;
  created_at: string;
};
export type ListedShare = ShareView & { meeting_title: string | null };
/** 미리보기 = be가 실제로 암호화할 페이로드 + 예상 만료(지금 + 기간). 실제 만료는 서버가 정한다. */
export type SharePreview = { payload: SharePayloadV1; expiresAtEstimate: string };

export const shareKeys = {
  meeting: (meetingId: string | undefined) => ["meeting-share", meetingId] as const,
  list: ["shares"] as const,
};

const KNOWN_ERRORS = [
  "SHARE_IN_PROGRESS",
  "SHARE_SERVICE_UNREACHABLE",
  "SHARE_SERVICE_BUSY",
  "SHARE_TOO_LARGE",
  "SUMMARY_NOT_READY",
  "MEETING_DELETED",
] as const;
type KnownShareError = (typeof KNOWN_ERRORS)[number];
/** `share` 사전의 오류 키 — 리터럴 유니온이라 `t(shareErrorKey(e))`가 타입 검사를 통과한다. */
export type ShareErrorKey = `errors.${KnownShareError}` | "errors.generic";

function isKnownError(code: string): code is KnownShareError {
  return (KNOWN_ERRORS as readonly string[]).includes(code);
}

/** be가 붙인 code → `share` 사전의 키. */
export function shareErrorKey(error: unknown): ShareErrorKey {
  return isApiError(error) && error.code && isKnownError(error.code) ? `errors.${error.code}` : "errors.generic";
}

/**
 * 공유가 꺼진 실행(Docker·데모 — be가 loopback이 아니거나 DEMO_READ_ONLY)에서는 공유 라우트가 404다.
 * 그때 `"disabled"`를 돌려 화면이 공유 UI를 통째로 숨긴다. 데모 빌드는 요청조차 하지 않는다.
 */
export function useMeetingShare(meetingId: string | undefined): UseQueryResult<ShareView | null | "disabled"> {
  return useQuery({
    queryKey: shareKeys.meeting(meetingId),
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<{ share: ShareView | null }>(`/meetings/${meetingId}/share`);
        // undefined를 돌려주면 TanStack이 오류로 본다 — 모양이 틀린 응답도 "공유 없음"으로 둔다.
        return data?.share ?? null;
      } catch (e) {
        if (isApiError(e) && e.statusCode === 404) return "disabled" as const;
        throw e;
      }
    },
    enabled: !!meetingId && !env.demoMode,
    retry: false,
  });
}

export function useSharePreview(
  meetingId: string,
  scope: ShareScope,
  uiLanguage: UiLanguage,
  durationDays: ShareDurationDays,
  enabled: boolean,
): UseQueryResult<SharePreview> {
  return useQuery({
    queryKey: ["share-preview", meetingId, scope, uiLanguage, durationDays],
    queryFn: async () => {
      const { data } = await apiClient.post<{ payload: SharePayloadV1; expires_at_estimate: string }>(
        `/meetings/${meetingId}/share/preview`,
        { scope, ui_language: uiLanguage, duration_days: durationDays },
      );
      return { payload: data.payload, expiresAtEstimate: data.expires_at_estimate };
    },
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

type CreateVars = {
  meetingId: string;
  scope: ShareScope;
  durationDays: ShareDurationDays;
  transcriptAck: boolean;
  uiLanguage: UiLanguage;
};

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation<ShareView, ApiError, CreateVars>({
    mutationFn: async (v) => {
      const { data } = await apiClient.post<{ share: ShareView }>(`/meetings/${v.meetingId}/share`, {
        scope: v.scope,
        duration_days: v.durationDays,
        consent_version: SHARE_CONSENT_VERSION,
        transcript_ack: v.transcriptAck,
        ui_language: v.uiLanguage,
      });
      return data.share;
    },
    onSuccess: (share, v) => {
      qc.setQueryData(shareKeys.meeting(v.meetingId), share);
      void qc.invalidateQueries({ queryKey: shareKeys.list });
    },
  });
}

export function useStopShare() {
  const qc = useQueryClient();
  return useMutation<{ share: ShareView; pending: boolean }, ApiError, { meetingId: string }>({
    mutationFn: async ({ meetingId }) => {
      const res = await apiClient.delete<{ share: ShareView }>(`/meetings/${meetingId}/share`);
      return { share: res.data.share, pending: res.status === 202 };
    },
    onSuccess: (r, v) => {
      qc.setQueryData(shareKeys.meeting(v.meetingId), r.pending ? r.share : null);
      void qc.invalidateQueries({ queryKey: shareKeys.list });
    },
  });
}

export function useShares(): UseQueryResult<ListedShare[] | "disabled"> {
  return useQuery({
    queryKey: shareKeys.list,
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<{ shares: ListedShare[] }>("/shares");
        return data.shares;
      } catch (e) {
        if (isApiError(e) && e.statusCode === 404) return "disabled" as const;
        throw e;
      }
    },
    enabled: !env.demoMode,
    retry: false,
  });
}
