import { z } from 'zod';
import { DeviceSchema, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { SUMMARY_MODELS } from '../contracts/model-catalog';
import { loadEnv } from '../config/env';
import { ProcessingConfig, resolvePreset } from './presets';
import { Logger } from '@nestjs/common';

const log = new Logger('ProcessingConfig');
const languageSchema = z.string().trim().min(1);
const devicesSchema = z.object({ diarization: DeviceSchema, stt: DeviceSchema }).strict();
const namedPresetSchema = z.object({
  preset: z.enum(['light', 'standard', 'quality']),
  language: languageSchema,
}).strict();

// 읽기(저장값 파싱) — summary_model은 optional. 이 필드가 없던 시절에 저장된
// custom 행이 있고, 그 행들의 실제 이전 동작은 env 값이었다 (spec §2).
export const StoredProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: languageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: devicesSchema,
    summary_model: z.enum(SUMMARY_MODELS).optional(),
  }).strict(),
  namedPresetSchema,
]);
export type StoredProcessingValue = z.infer<typeof StoredProcessingValueSchema>;

// 쓰기(PUT body) — custom은 전 필드 필수. 이름 프리셋은 이름+언어만(개별 노브 혼입 400).
export const PutProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: languageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: devicesSchema,
    summary_model: z.enum(SUMMARY_MODELS),
  }).strict(),
  namedPresetSchema,
]);
export type PutProcessingValue = z.infer<typeof PutProcessingValueSchema>;

// env는 v1 형태(WHISPER_DEVICE 단일 값) — v1과 동일 매핑으로 v2 config 변환 (spec §1)
export function envFallbackProcessingConfig(): ProcessingConfig {
  const env = loadEnv();
  if (env.WHISPER_DEVICE === 'cuda') log.warn('WHISPER_DEVICE=cuda — treating as cpu (cuda is a non-goal)');
  const dev = env.WHISPER_DEVICE === 'mps' ? ('gpu' as const) : ('cpu' as const);
  return {
    preset: 'custom', preset_revision: null, language: env.STT_LANGUAGE,
    whisper_model: env.WHISPER_MODEL, devices: { diarization: dev, stt: dev },
    summary_model: env.SUMMARY_LLM_MODEL,
  };
}

export function resolveStoredValue(value: StoredProcessingValue): ProcessingConfig {
  if (value.preset === 'custom') {
    return {
      preset: 'custom', preset_revision: null, language: value.language,
      whisper_model: value.whisper_model, devices: value.devices,
      // 필드 부재는 "이 행이 쓰일 당시엔 env가 진실이었다"는 뜻 (spec §2).
      // 저장된 값이 있으면 언제나 그 값이 진실이다.
      summary_model: value.summary_model ?? loadEnv().SUMMARY_LLM_MODEL,
    };
  }
  return resolvePreset(value.preset, value.language);
}
