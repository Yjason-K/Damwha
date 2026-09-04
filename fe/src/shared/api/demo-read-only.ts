import type { AxiosInstance, InternalAxiosRequestConfig } from "axios";

import { ApiError } from "@/shared/api/client";

export const DEMO_READ_ONLY_CODE = "DEMO_READ_ONLY";

const SAFE_METHODS = new Set(["get", "head", "options"]);
// 검색은 읽기인데 본문이 커서 POST다 — 서버 가드(be DemoReadOnlyGuard)와 같은 예외.
const READ_POSTS = /^\/?search\/?$/;

function isRead(config: InternalAxiosRequestConfig): boolean {
  const method = (config.method ?? "get").toLowerCase();
  if (SAFE_METHODS.has(method)) return true;
  const path = (config.url ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/api/, "").split("?")[0];
  return method === "post" && READ_POSTS.test(path);
}

/**
 * 읽기 전용 데모의 요청 인터셉터. GET 외 요청을 서버에 닿기 전에 ApiError(403,
 * DEMO_READ_ONLY)로 거절하고 notify를 한 번 부른다. 이미 실패 토스트를 띄우는 mutation은
 * isDemoBlocked로 중복을 피한다.
 */
export function installDemoReadOnly(
  client: AxiosInstance,
  notify: () => void,
  { throttleMs = 3_000 }: { throttleMs?: number } = {},
): void {
  // 메모 자동저장(800ms debounce)처럼 연속으로 막히는 요청이 토스트를 연발하지 않게.
  let lastNotified = -Infinity;
  client.interceptors.request.use((config) => {
    if (isRead(config)) return config;
    const now = Date.now();
    if (now - lastNotified >= throttleMs) {
      lastNotified = now;
      notify();
    }
    return Promise.reject(
      new ApiError(403, "데모 사이트라 결과 확인만 할 수 있어요.", DEMO_READ_ONLY_CODE),
    );
  });
}

export function isDemoBlocked(error: unknown): boolean {
  return error instanceof ApiError && error.code === DEMO_READ_ONLY_CODE;
}
