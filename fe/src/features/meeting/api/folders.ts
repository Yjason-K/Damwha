import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { Folder } from "../model/types";
import type { WireFolder } from "./types";

const toFolder = (w: WireFolder): Folder => ({
  id: w.id,
  name: w.name,
  isDefault: w.is_default,
});

/**
 * 폴더 목록 — 기본 폴더가 먼저, 나머지는 이름순(서버 순서 그대로).
 * 폴더별 회의 수는 여기 없다: 좌측 목록이 이미 받은 회의에서 세야 보이는 목록과
 * 어긋나지 않는다(스펙 §2.6).
 */
export function useFolders(): UseQueryResult<Folder[]> {
  return useQuery({
    queryKey: ["folders"],
    queryFn: async () => {
      const { data } = await apiClient.get<WireFolder[]>("/folders");
      return data.map(toFolder);
    },
  });
}

/** 폴더 만들기 (POST /folders). 이름이 겹치면 409. */
export function useCreateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { name: string }) => {
      const { data } = await apiClient.post<WireFolder>("/folders", vars);
      return toFolder(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/** 폴더 이름 바꾸기 (PATCH /folders/:id). 기본 폴더는 서버가 400으로 막는다. */
export function useRenameFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; name: string }) => {
      const { data } = await apiClient.patch<WireFolder>(
        `/folders/${vars.id}`,
        { name: vars.name },
      );
      return toFolder(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/**
 * 폴더 삭제 (DELETE /folders/:id). 안의 회의는 서버가 기본 폴더로 옮긴다 — 그래서
 * 목록과 열려 있는 회의 상세도 다시 읽어야 폴더 표시가 맞는다.
 */
export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string }) => {
      await apiClient.delete(`/folders/${vars.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      queryClient.invalidateQueries({ queryKey: ["meeting"] });
    },
  });
}
