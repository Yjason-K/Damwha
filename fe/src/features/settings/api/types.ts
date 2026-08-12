/**
 * 처리 설정 와이어 타입 — be `GET/PUT /settings/processing`,
 * `GET /system/capabilities` 계약 (2026-07-13 processing-settings spec).
 */

export type PresetName = "light" | "standard" | "quality";
export type Device = "cpu" | "gpu";
export type WhisperModel =
  | "tiny"
  | "base"
  | "small"
  | "medium"
  | "large-v3"
  | "large-v3-turbo";

/** BE `src/contracts/model-catalog.ts`의 SUMMARY_MODELS 미러 — 함께 갱신할 것. */
export type SummaryModel =
  | "qwen3.5:4b-mlx"
  | "qwen3.5:8b-mlx"
  | "qwen3.5:14b-mlx";

/** GET /settings/processing — 항상 resolved 뷰. */
export type ProcessingConfig = {
  preset: PresetName | "custom";
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;
};

/** PUT /settings/processing — 이름 프리셋은 이름+언어만, custom은 전 필드. */
export type ProcessingSettingsUpdate =
  | { preset: PresetName; language: string }
  | {
      preset: "custom";
      language: string;
      whisper_model: WhisperModel;
      devices: { diarization: Device; stt: Device };
      summary_model: SummaryModel;
    };

/**
 * job 한정 오버라이드 — 업로드 multipart `processing` 필드(JSON 문자열) /
 * 재처리 body. 개별 필드(language 포함)가 하나라도 있으면 서버가 preset을
 * custom으로 기록한다.
 */
export type ProcessingOverride = {
  preset?: PresetName;
  whisper_model?: WhisperModel;
  devices?: { diarization?: Device; stt?: Device };
  language?: string;
  summary_model?: SummaryModel;
};

/** GET /system/capabilities — gpu_eligible은 하드웨어 적합성만 의미. */
export type Capabilities = {
  platform: string;
  arch: string;
  chip: string | null;
  memory_gb: number;
  gpu_eligible: boolean;
  recommended_preset: PresetName | null;
};
