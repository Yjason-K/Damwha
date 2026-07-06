import { isApiError } from "@/shared/api/client";

/** API 실패를 사용자에게 보여줄 메시지로 변환. 인터셉터가 정규화한 서버
 * 메시지(예: 409 진행 중 등록)를 그대로 표출한다. */
export function toErrorMessage(error: unknown): string {
  return isApiError(error) ? error.message : "잠시 후 다시 시도해주세요.";
}
