import { z } from 'zod';
import { DeviceSchema, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { loadEnv } from '../config/env';
import { ProcessingConfig, resolvePreset } from './presets';
import { Logger } from '@nestjs/common';

const log = new Logger('ProcessingConfig');
const languageSchema = z.string().trim().min(1);

// PUT/저장 값 — 이름 프리셋은 이름+언어만(strict: 개별 노브 혼입 400), custom은 전 필드
export const StoredProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: languageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: z.object({ diarization: DeviceSchema, stt: DeviceSchema }).strict(),
  }).strict(),
  z.object({
    preset: z.enum(['light', 'standard', 'quality']),
    language: languageSchema,
  }).strict(),
]);
export type StoredProcessingValue = z.infer<typeof StoredProcessingValueSchema>;

// env는 v1 형태(WHISPER_DEVICE 단일 값) — v1과 동일 매핑으로 v2 config 변환 (spec §1)
export function envFallbackProcessingConfig(): ProcessingConfig {
  const env = loadEnv();
  if (env.WHISPER_DEVICE === 'cuda') log.warn('WHISPER_DEVICE=cuda — treating as cpu (cuda is a non-goal)');
  const dev = env.WHISPER_DEVICE === 'mps' ? ('gpu' as const) : ('cpu' as const);
  return {
    preset: 'custom', preset_revision: null, language: env.STT_LANGUAGE,
    whisper_model: env.WHISPER_MODEL, devices: { diarization: dev, stt: dev },
  };
}

export function resolveStoredValue(value: StoredProcessingValue): ProcessingConfig {
  if (value.preset === 'custom') {
    return { preset: 'custom', preset_revision: null, language: value.language,
             whisper_model: value.whisper_model, devices: value.devices };
  }
  return resolvePreset(value.preset, value.language);
}
