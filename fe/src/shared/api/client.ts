import axios from "axios";
import type { AxiosError } from "axios";
import { env } from "@/shared/config/env";
import { installDemoReadOnly } from "@/shared/api/demo-read-only";
import { toast } from "@/shared/ui/use-toast";

/** 정규화된 API 에러 — 인터셉터가 모든 실패를 이 형태로 reject한다. */
export class ApiError extends Error {
  readonly statusCode: number;
  /** 서버/인터셉터가 붙이는 기계용 코드. 예: "DEMO_READ_ONLY" (demo-read-only.ts). */
  readonly code?: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export const apiClient = axios.create({
  baseURL: env.apiBaseUrl,
  headers: { "Content-Type": "application/json" },
});

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ message?: string }>) => {
    const status = error.response?.status ?? 0;
    const serverMessage = error.response?.data?.message;
    const message =
      typeof serverMessage === "string" && serverMessage
        ? serverMessage
        : error.response
          ? error.message || "알 수 없는 오류가 발생했어요."
          : "서버에 연결할 수 없어요.";
    return Promise.reject(new ApiError(status, message));
  },
);

// 공개 데모 빌드(VITE_DEMO_MODE=true)에서만: GET 외 요청을 서버에 보내기 전에 끊고 토스트 한 번.
// 보호 장치는 API의 DemoReadOnlyGuard다 — 이건 optimistic update 깜빡임을 막는 UX 층(설계 §3.6).
if (env.demoMode) {
  installDemoReadOnly(apiClient, () =>
    toast({
      title: "데모 사이트라 사용해볼 수 없어요.",
      description: "미리 처리해 둔 회의의 결과만 확인할 수 있어요.",
      variant: "info",
    }),
  );
}
