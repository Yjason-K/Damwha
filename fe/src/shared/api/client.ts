import axios from "axios";
import type { AxiosError } from "axios";
import { env } from "@/shared/config/env";

/** 정규화된 API 에러 — 인터셉터가 모든 실패를 이 형태로 reject한다. */
export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
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
