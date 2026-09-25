import type { ModelRow } from "../api/types";

/**
 * 모델 행의 버튼과 오류 문구 (모델 다운로드 관리 스펙 §6.4). 문구는 job의 **code**로 고른다 — 자유
 * 문구로 고르지 않는다. 디스크 부족만 worker 문구(남은·필요 용량)를 그대로 보인다.
 */
export type RowActionKind = "download" | "redownload" | "cancel" | "delete" | null;

const active = (r: ModelRow) => r.job !== null && (r.job.status === "queued" || r.job.status === "running");

export function rowAction(r: ModelRow): { kind: RowActionKind; reason: string | null } {
  if (r.downloading !== null || (active(r) && r.job?.type === "download_model")) return { kind: "cancel", reason: null };
  if (active(r)) return { kind: null, reason: null }; // 지우는 중
  if (r.installed === "no") return { kind: "download", reason: null };
  if (r.installed === "partial") return { kind: "redownload", reason: null };
  if (r.installed !== "yes") return { kind: null, reason: null };
  if (r.deletable) return { kind: "delete", reason: null };
  if (r.inUseFor.includes("fixed")) return { kind: null, reason: null };
  return {
    kind: null,
    reason: r.inUseFor.length > 0 ? "지금 설정에서 쓰고 있어요" : "처리 중인 작업이 쓰고 있어요",
  };
}

export function jobErrorText(r: ModelRow): { text: string; accept: boolean } | null {
  const j = r.job;
  if (j === null || j.status !== "failed" || j.error === null) return null;
  const code = j.error.code;
  if (code === "download_cancelled") return null;
  if (j.type === "download_model" && r.installed === "yes") return null; // 그 뒤에 받아졌다
  if (code === "DISK_FULL") return { text: j.error.message, accept: false };
  if (code === "hf_token_invalid")
    return { text: "허깅페이스 토큰이 유효하지 않아 받지 못했어요. 토큰을 확인해 주세요.", accept: false };
  if (code === "hf_gate_not_accepted") return { text: "모델 사용 조건에 동의해야 받을 수 있어요.", accept: true };
  if (code === "model_in_use") return { text: "처리 중인 작업이 쓰고 있어 지우지 않았어요.", accept: false };
  return j.type === "delete_model"
    ? { text: "지우지 못했어요.", accept: false }
    : { text: "받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요.", accept: false };
}

export function conflictText(code: string | undefined): string | null {
  switch (code) {
    case "model_in_use_by_settings":
      return "지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요.";
    case "model_in_use_by_job":
      return "처리 중인 작업이 쓰고 있어요. 끝난 뒤 지울 수 있어요.";
    case "model_busy":
      return "이 모델에 대한 다른 작업이 진행 중이에요.";
    default:
      return null;
  }
}

export function exceedsFreeSpace(r: ModelRow, freeBytes: number | null): boolean {
  return r.installed !== "yes" && r.approxBytes !== null && freeBytes !== null && r.approxBytes > freeBytes;
}
