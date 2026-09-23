import axios from "axios";
import type { AxiosError } from "axios";
import { env } from "@/shared/config/env";
import { installDemoReadOnly } from "@/shared/api/demo-read-only";
import { toast } from "@/shared/ui/use-toast";

/** 정규화된 API 에러 — 인터셉터가 모든 실패를 이 형태로 reject한다. */
export class ApiError extends Error {
  readonly statusCode: number;
  /** 서버/인터셉터가 붙이는 기계용 코드. 예: "DEMO_READ_ONLY" (demo-read-only.ts), "DISK_FULL" (아래). */
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

const DISK_FULL_STATUS = 507;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * 바이트 → 사람이 읽는 크기, **1000 기준**. worker의 `models/disk.py`의 `format_bytes`와 같은
 * 기준이어야 한다 — 다르면 같은 디스크가 데스크톱 상태 창과 이 업로드 오류에서 다른 숫자로
 * 보인다(Task 9 리뷰 포인트). 이 파일에 이미 있는 `formatBytes`(new-meeting-dialog.tsx, 고른
 * 파일 크기 표시용)는 1024 기준이라 여기서는 재사용하지 않는다 — 용도도 기준도 다르다.
 */
function formatDiskBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  let size = n;
  for (const unit of BYTE_UNITS.slice(1)) {
    size /= 1000;
    if (size < 1000) return `${size.toFixed(1)} ${unit}`;
  }
  return `${size.toFixed(1)} ${BYTE_UNITS[BYTE_UNITS.length - 1]}`;
}

/**
 * 507 DISK_FULL 응답(`be/src/storage/disk-full.filter.ts`) → 화면 문구.
 * `desktop/src/diagnostics/causes.ts`의 `diskFull`이 정한 모양
 * (`디스크 공간이 부족해요 — 남은 용량 X, 필요한 용량 Y.`)과 바이트 단위로 맞춘다 — 그 파일의
 * 머리 주석이 사본을 금하므로 다른 모양을 새로 짓지 않는다. 업로드 시점에는 "필요한 용량"을
 * 알 수 없어 `needed`가 null로 온다(같은 필터, 모델 다운로드 경로는 안다) — 그때는 남은 용량만
 * 말한다. 안내 문장은 `desktop/src/windows/shell-hints.ts:78`의 diskFull 안내와 같은 어구
 * ("다른 파일을 정리해 공간을 만든 뒤")로 시작하되, 복구 동작이 데스크톱은 "서비스 다시 시작",
 * 여기는 "다시 올리기"로 갈린다.
 */
function diskFullMessage(free: number, needed: number | null): string {
  const cause =
    needed == null
      ? `디스크 공간이 부족해요 — 남은 용량 ${formatDiskBytes(free)}.`
      : `디스크 공간이 부족해요 — 남은 용량 ${formatDiskBytes(free)}, 필요한 용량 ${formatDiskBytes(needed)}.`;
  return `${cause} 다른 파일을 정리해 공간을 만든 뒤 다시 올려 주세요.`;
}

export const apiClient = axios.create({
  baseURL: env.apiBaseUrl,
  headers: { "Content-Type": "application/json" },
});

apiClient.interceptors.response.use(
  (response) => response,
  (
    error: AxiosError<{
      message?: string;
      code?: string;
      free?: number;
      needed?: number | null;
    }>,
  ) => {
    const status = error.response?.status ?? 0;
    const data = error.response?.data;

    if (
      status === DISK_FULL_STATUS &&
      data?.code === "DISK_FULL" &&
      typeof data.free === "number"
    ) {
      return Promise.reject(
        new ApiError(
          status,
          diskFullMessage(data.free, data.needed ?? null),
          data.code,
        ),
      );
    }

    const serverMessage = data?.message;
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
