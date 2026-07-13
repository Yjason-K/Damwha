import { Device, WHISPER_MODELS } from '../contracts/job-payload.schema';

export const PRESET_REVISION = '2026-07-13.1'; // 프리셋 정의 변경 시 갱신 (spec §2)
export type PresetName = 'light' | 'standard' | 'quality';
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export interface ProcessingConfig {
  preset: PresetName | 'custom';
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
}

const PRESETS: Record<PresetName, Pick<ProcessingConfig, 'whisper_model' | 'devices'>> = {
  light: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'cpu' } },
  standard: { whisper_model: 'large-v3-turbo', devices: { diarization: 'gpu', stt: 'gpu' } },
  quality: { whisper_model: 'large-v3', devices: { diarization: 'gpu', stt: 'gpu' } },
};

export function resolvePreset(name: PresetName, language: string): ProcessingConfig {
  return { preset: name, preset_revision: PRESET_REVISION, language, ...PRESETS[name] };
}
