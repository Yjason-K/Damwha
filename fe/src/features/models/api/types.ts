import type { ModelRole, SttBackend } from "@damwha/contracts";

/**
 * `GET /models` 와이어 타입 — be `src/models/models-view.ts`의 `ModelsView`와 같은 모양
 * (모델 다운로드 관리 스펙 §5.1).
 */
export type InUse = "stt" | "summary" | "lens" | "fixed";
export type Installed = "yes" | "no" | "partial" | "unknown";

/** (D2) 논리 키의 마지막 받기·삭제 job (모델 다운로드 관리 스펙 §5.1·§5.2). */
export interface ModelJobRef {
  id: string;
  type: "download_model" | "delete_model";
  status: "queued" | "running" | "done" | "failed";
  error: { code: string; message: string } | null;
}

/** 받기·삭제 요청의 논리 키 (스펙 §5.2) — repo 풀이에 기대지 않는다. */
export interface ModelKey {
  role: ModelRole;
  name: string;
  backend: SttBackend | null;
}

export interface ModelRow {
  role: ModelRole;
  name: string;
  backend: SttBackend | null;
  repoId: string | null;
  inUseFor: InUse[];
  installed: Installed;
  sizeBytes: number | null;
  approxBytes: number | null;
  downloading: { bytesDone: number; bytesTotal: number } | null;
  deletable: boolean;
  /** (D2) 이 논리 키의 마지막 받기·삭제 job. 없으면 null. */
  job: ModelJobRef | null;
}

export interface ModelsView {
  scannedAt: string | null;
  totalBytes: number | null;
  pending: boolean;
  models: ModelRow[];
  /** (D2) worker가 잰 남은 용량. 못 읽었거나 아직 없으면 null. */
  freeBytes: number | null;
}
