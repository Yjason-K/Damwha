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
  SttLanguage,
} from "@damwha/contracts";
import type {
  PresetName,
  Device,
  WhisperModel,
  SummaryModel,
  SttLanguage,
} from "@damwha/contracts";

/** GET /settings/processing — 항상 resolved 뷰. */
export type ProcessingConfig = {
  preset: PresetName | "custom";
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;
};

/**
 * 모델 준비 상태 한 항목 — `app_setting.model_readiness`의 entries 하나 (Phase 4 스펙 §6.9).
 * worker·embed가 쓰고 API는 읽기만 한다. 앱 상태 창과 이 화면이 **같은 값**을 본다.
 */
export type ModelReadinessEntry = {
  /** HF repo id. */
  key: string;
  state: "downloading" | "ready" | "failed";
  bytesDone: number;
  /** 모르는 구간은 0이다 — 그때는 퍼센트를 보이지 않는다. */
  bytesTotal: number;
  startedAt: string | null;
  /** ISO8601. 무진행("중단됨") 판정의 유일한 근거다. */
  updatedAt: string | null;
  /** 어느 프로세스가 받는가 — 검색 임베딩은 `"embed"`, 나머지는 워커 id다. */
  writer: string;
  attempt: number;
  error: string | null;
  errorKind: "PERMANENT" | "TRANSIENT" | null;
};

export type ModelReadiness = {
  updatedAt: string | null;
  entries: ModelReadinessEntry[];
};

/**
 * `GET /settings/processing`의 실제 응답 — resolved 뷰 **+ 모델 준비 상태**.
 *
 * `ProcessingConfig`를 넓히지 않고 교차 타입으로 둔다: 그 타입은 업로드·재처리의 오버라이드와
 * 프리셋 폼이 쓰는 "설정" 그 자체이고, 준비 상태는 같은 응답에 함께 오는 곁가지다.
 * `PUT` 응답에는 없다.
 */
export type ProcessingSettings = ProcessingConfig & {
  modelReadiness: ModelReadiness;
};

/**
 * PUT /settings/processing — 이름 프리셋은 이름+언어만, custom은 전 필드.
 * language가 `SttLanguage`인 건 쓰기 경로라서다 — 위 `ProcessingConfig`는 카탈로그
 * 도입 전 저장값을 그대로 돌려받을 수 있어 `string`으로 남는다(BE와 같은 비대칭).
 */
export type ProcessingSettingsUpdate =
  | { preset: PresetName; language: SttLanguage }
  | {
      preset: "custom";
      language: SttLanguage;
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
  language?: SttLanguage;
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
