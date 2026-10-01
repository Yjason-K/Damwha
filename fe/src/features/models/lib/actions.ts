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
  // 설정에서 쓰는 모델(과 고정 모델)은 행의 배지가 이미 이유를 말한다 — 사유를 겹쳐 적지 않는다.
  // 배지로는 알 수 없는 경우(처리 중인 작업이 쓰는 모델)만 흐린 사유를 붙인다.
  if (r.inUseFor.length > 0) return { kind: null, reason: null };
  return { kind: null, reason: "처리 중인 작업이 쓰고 있어요" };
}

export function jobErrorText(r: ModelRow): { text: string } | null {
  const j = r.job;
  if (j === null || j.status !== "failed" || j.error === null) return null;
  const code = j.error.code;
  if (code === "download_cancelled") return null;
  if (j.type === "download_model" && r.installed === "yes") return null; // 그 뒤에 받아졌다
  if (code === "DISK_FULL") return { text: j.error.message };
  if (code === "model_in_use") return { text: "처리 중인 작업이 쓰고 있어 지우지 않았어요." };
  // 앱 번들이 깨졌다 — 다시 받아도 풀리지 않는다 (worker는 hub로 가지 않는다).
  if (code === "diarization_bundle_missing") {
    return { text: "앱에 포함된 화자 분리 모델을 찾을 수 없어요. 앱을 다시 설치해 주세요." };
  }
  return j.type === "delete_model"
    ? { text: "지우지 못했어요." }
    : { text: "받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요." };
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
