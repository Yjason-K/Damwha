export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api",
  /** 공개 데모 빌드. 읽기 전용 인터셉터와 첫 방문 안내 모달을 켠다(설계 §3.6). */
  demoMode: import.meta.env.VITE_DEMO_MODE === "true",
} as const;
