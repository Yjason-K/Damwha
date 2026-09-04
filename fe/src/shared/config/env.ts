const tourMeetingId = import.meta.env.VITE_DEMO_TOUR_MEETING_ID?.trim();

export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api",
  /** 공개 데모 빌드. 읽기 전용 인터셉터와 첫 방문 안내 모달을 켠다(설계 §3.6). */
  demoMode: import.meta.env.VITE_DEMO_MODE === "true",
  /**
   * 데모 둘러보기의 가짜 업로드 설정(투어 설계 §6). 데모 빌드가 아니거나 회의 id가
   * 없으면 null — 그러면 투어는 업로드 단계를 빼고 돈다.
   */
  demoTour:
    import.meta.env.VITE_DEMO_MODE === "true" && tourMeetingId
      ? {
          meetingId: tourMeetingId,
          fileLabel: import.meta.env.VITE_DEMO_TOUR_FILE_LABEL?.trim() || "테스트 오디오",
          searchQuery: import.meta.env.VITE_DEMO_TOUR_SEARCH_QUERY?.trim() ?? "",
        }
      : null,
} as const;
