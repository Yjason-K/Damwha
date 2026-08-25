/**
 * 처리 설정 와이어 타입 — be `GET/PUT /settings/processing`,
 * `GET /system/capabilities` 계약 (2026-07-13 processing-settings spec).
 */

/**
 * 네 enum은 BE와 값이 정확히 같아야 하는 것들이라 `@damwha/contracts`가 갖는다.
 * 예전에는 여기에 손으로 베껴 뒀고, 2026-08-12 요약 카탈로그가 Ollama 태그에서
 * HF repo id로 바뀌었을 때 FE만 옛 값을 계속 보내 `PUT /settings/processing`이
 * `Invalid input` 400만 뱉었다. 이제 어긋나면 컴파일이 깨진다.
 */
export type {
  PresetName,
  Device,
  WhisperModel,
  SummaryModel,
} from "@damwha/contracts";
import type { PresetName, Device, WhisperModel, SummaryModel } from "@damwha/contracts";

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
