import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ApiError, apiClient, isApiError } from "@/shared/api/client";
import { env } from "@/shared/config/env";

export type LinkState =
  | { kind: "absent" }
  | { kind: "current" }
  | { kind: "other_damwha"; target: string }
  | { kind: "foreign"; target: string; isFile: boolean };

export type ClientRegistration = "none" | "ours" | { other: string } | { error: string };
export type ClientState = { installed: false } | { installed: true; registration: ClientRegistration };

export const CLIENT_IDS = ["claude-code", "codex"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export type IntegrationsView = {
  cli: { link: LinkState; link_path: string; on_path: boolean };
  clients: Record<ClientId, ClientState>;
  manual: { link: string; claudeCode: string; codex: string; genericJson: string };
};

export const integrationsKey = ["integrations"] as const;

/**
 * 연동 API는 데스크톱(런처가 있고 loopback이며 데모가 아님)에서만 산다. 그 밖(Docker·데모·브라우저 개발)에서는
 * 404라 `"disabled"`를 돌려 화면이 섹션을 통째로 숨긴다. 데모 빌드는 요청조차 하지 않는다.
 */
export function useIntegrations(): UseQueryResult<IntegrationsView | "disabled"> {
  return useQuery({
    queryKey: integrationsKey,
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<IntegrationsView>("/integrations");
        return data;
      } catch (e) {
        if (isApiError(e) && e.statusCode === 404) return "disabled" as const;
        throw e;
      }
    },
    enabled: !env.demoMode,
    retry: false,
  });
}

function useInvalidating<TData, TVars = void>(fn: (v: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation<TData, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationsKey }),
  });
}

export const useInstallCli = () =>
  useInvalidating(async () => (await apiClient.post<LinkState>("/integrations/cli/install")).data);

export const useRemoveCli = () =>
  useInvalidating(async () => {
    await apiClient.delete("/integrations/cli");
  });

export const useInstallClient = (id: ClientId) =>
  useInvalidating(
    async (v: { replace?: boolean }) =>
      (await apiClient.post<ClientState>(`/integrations/${id}/install`, v.replace ? { replace: true } : {})).data,
  );

export const useRemoveClient = (id: ClientId) =>
  useInvalidating(async () => {
    await apiClient.delete(`/integrations/${id}`);
  });
