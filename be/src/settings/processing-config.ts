import { z } from 'zod';
import { STT_LANGUAGES } from '@damwha/contracts';
import { DeviceSchema, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { SUMMARY_MODELS } from '../contracts/model-catalog';
import { loadEnv } from '../config/env';
import { ProcessingConfig, resolvePreset } from './presets';
import { Logger } from '@nestjs/common';

const log = new Logger('ProcessingConfig');

// 언어는 읽기와 쓰기가 비대칭이다. 쓰기는 카탈로그로 조인다 — 이 필드는 예전에
// FE의 자유 텍스트 입력이었고, `kor`/`한국어` 같은 값이 검증 없이 whisper까지
// 그대로 흘러 조용히 엉뚱하게 디코딩됐다. 읽기는 계속 자유 문자열이다: 조이기
// 전에 저장된 행과 env `STT_LANGUAGE`(자유값)를 400/파싱 실패로 만들지 않는다.
const storedLanguageSchema = z.string().trim().min(1);
const putLanguageSchema = z.enum(STT_LANGUAGES);

const devicesSchema = z.object({ diarization: DeviceSchema, stt: DeviceSchema }).strict();
const namedPresetSchema = (language: z.ZodTypeAny) =>
  z.object({
    preset: z.enum(['light', 'standard', 'quality']),
    language,
  }).strict();

// 읽기(저장값 파싱) — summary_model은 optional. 이 필드가 없던 시절에 저장된
// custom 행이 있고, 그 행들의 실제 이전 동작은 env 값이었다 (spec §2).
export const StoredProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: storedLanguageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: devicesSchema,
    summary_model: z.enum(SUMMARY_MODELS).optional(),
  }).strict(),
  namedPresetSchema(storedLanguageSchema),
]);
export type StoredProcessingValue = z.infer<typeof StoredProcessingValueSchema>;

// 쓰기(PUT body) — custom은 전 필드 필수. 이름 프리셋은 이름+언어만(개별 노브 혼입 400).
export const PutProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: putLanguageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: devicesSchema,
    summary_model: z.enum(SUMMARY_MODELS),
  }).strict(),
  namedPresetSchema(putLanguageSchema),
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
