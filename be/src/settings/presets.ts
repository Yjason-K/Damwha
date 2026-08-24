import { Device, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { SummaryModel } from '../contracts/model-catalog';

export const PRESET_REVISION = '2026-08-12.3'; // 프리셋 정의 변경 시 갱신 (spec §2)
export type PresetName = 'light' | 'standard' | 'quality';
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export interface ProcessingConfig {
  preset: PresetName | 'custom';
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;
}

const PRESETS: Record<
  PresetName,
  Pick<ProcessingConfig, 'whisper_model' | 'devices' | 'summary_model'>
> = {
  light: {
    whisper_model: 'small',
    devices: { diarization: 'gpu', stt: 'cpu' },
    summary_model: 'mlx-community/Qwen3.5-4B-8bit',
  },
  standard: {
    whisper_model: 'large-v3-turbo',
    devices: { diarization: 'gpu', stt: 'gpu' },
    summary_model: 'mlx-community/Qwen3.5-9B-8bit',
  },
  quality: {
    whisper_model: 'large-v3',
    devices: { diarization: 'gpu', stt: 'gpu' },
    summary_model: 'mlx-community/Qwen3.5-27B-8bit',
  },
};

export function resolvePreset(name: PresetName, language: string): ProcessingConfig {
  return {
    preset: name,
    preset_revision: PRESET_REVISION,
    language,
    whisper_model: PRESETS[name].whisper_model,
    devices: { ...PRESETS[name].devices },
    summary_model: PRESETS[name].summary_model,
  };
}
