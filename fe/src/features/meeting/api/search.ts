import { useEffect, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { SearchResponse, SearchResult } from "./types";

/** 검색 히트 — UI 소비 형태. */
export type SearchHit = {
  utteranceId: string;
  meetingId: string;
  meetingTitle: string | null;
  text: string;
  startMs: number;
  speakerName: string | null;
};

function toSearchHit(result: SearchResult): SearchHit {
  return {
    utteranceId: result.utteranceId,
    meetingId: result.meetingId,
    meetingTitle: result.meetingTitle,
    text: result.text ?? "",
    startMs: result.startMs,
    speakerName: result.speaker?.name ?? null,
  };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * 발화 검색. 250ms 디바운스. 길이 제한 없이 실행한다 — 빈 질의는 백엔드 브라우즈
 * 모드(최근 발화 나열)를 태우므로 팔레트를 열자마자 결과를 보여줄 수 있다.
 *
 * `enabled`는 팔레트가 열려 있는 동안만 조회하기 위한 것이다. 셸이 모든 화면에
 * 상주하게 되면서, 이게 없으면 사용자가 팔레트를 연 적도 없는 화자 관리·처리
 * 설정 페이지를 열 때마다 빈 질의 검색이 나간다. staleTime(60초) 덕에 팔레트를
 * 다시 열 때는 캐시가 받아주므로 "열자마자 결과" 성질은 유지된다.
 */
export function useSearch(
  q: string,
  enabled = true,
): UseQueryResult<SearchHit[]> {
  const query = useDebouncedValue(q.trim(), 250);
  return useQuery({
    queryKey: ["search", query],
    enabled,
    queryFn: async () => {
      const { data } = await apiClient.post<SearchResponse>("/search", {
        q: query,
      });
      return data.results.map(toSearchHit);
    },
  });
}
