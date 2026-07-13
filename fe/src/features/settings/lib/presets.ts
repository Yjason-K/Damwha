import type { Device, PresetName, WhisperModel } from "../api/types";

/**
 * 프리셋 카드 표시용 메타 — 값의 진실원은 BE(`be/src/settings/presets.ts`,
 * PRESET_REVISION 2026-07-13.1). 여기 값은 카드 요약 표시 전용이며, 저장 시엔
 * 프리셋 이름만 보내고 서버가 resolve한다. BE 프리셋 변경 시 함께 갱신할 것.
 */
export const PRESET_META: Record<
  PresetName,
  {
    label: string;
    desc: string;
    whisper_model: WhisperModel;
    devices: { diarization: Device; stt: Device };
  }
> = {
  light: {
    label: "가볍게",
    desc: "8GB 램에 알맞아요",
    whisper_model: "small",
    devices: { diarization: "gpu", stt: "cpu" },
  },
  standard: {
    label: "표준",
    desc: "16–32GB 램에 알맞아요",
    whisper_model: "large-v3-turbo",
    devices: { diarization: "gpu", stt: "gpu" },
  },
  quality: {
    label: "고품질",
    desc: "64GB+ 램에 알맞아요",
    whisper_model: "large-v3",
    devices: { diarization: "gpu", stt: "gpu" },
  },
};

export const PRESET_ORDER: PresetName[] = ["light", "standard", "quality"];

/**
 * PRESET_META가 반영한 BE 프리셋 정의 revision. GET 응답의 preset_revision과
 * 다르면 서버 프리셋이 갱신된 것 — 카드 요약이 실제와 다를 수 있음을 UI에
 * 알린다 (드리프트 감지; 리뷰 #6).
 */
export const PRESET_META_REVISION = "2026-07-13.1";

export const WHISPER_MODEL_OPTIONS: { value: WhisperModel; label: string }[] = [
  { value: "tiny", label: "tiny — 가장 빠름, 낮은 정확도" },
  { value: "base", label: "base" },
  { value: "small", label: "small" },
  { value: "medium", label: "medium" },
  { value: "large-v3-turbo", label: "large-v3-turbo — 권장 균형" },
  { value: "large-v3", label: "large-v3 — 가장 정확, 느림" },
];

/** 디바이스 요약 문자열 — 카드/고급 요약에 사용. */
export function deviceSummary(devices: {
  diarization: Device;
  stt: Device;
}): string {
  return `화자 분리 ${devices.diarization.toUpperCase()} · 전사 ${devices.stt.toUpperCase()}`;
}
