import type { ModelRole, SttBackend } from "@damwha/contracts";

/**
 * `GET /models` 와이어 타입 — be `src/models/models-view.ts`의 `ModelsView`와 같은 모양
 * (모델 다운로드 관리 스펙 §5.1).
 */
export type InUse = "stt" | "summary" | "lens" | "fixed";
export type Installed = "yes" | "no" | "partial" | "unknown";

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
}

export interface ModelsView {
  scannedAt: string | null;
  totalBytes: number | null;
  pending: boolean;
  models: ModelRow[];
}
