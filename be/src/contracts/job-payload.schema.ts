import { z } from 'zod';
import { loadEnv } from '../config/env';
// 타입 전용 import — 런타임 배출 없음(에러 소거). presets.ts는 WHISPER_MODELS(값)를
// 이 파일에서 import하므로, 값 import로 되받으면 런타임 순환이 생긴다. type-only로 차단.
import type { ProcessingConfig } from '../settings/presets';

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const;
export const DeviceSchema = z.enum(['cpu', 'gpu']);
export type Device = z.infer<typeof DeviceSchema>;

const DiarizationSchema = z.object({
  model: z.string(),
  min_speakers: z.number().int().nullable(),
  max_speakers: z.number().int().nullable(),
});
const EmbeddingSchema = z.object({ model: z.string(), dimension: z.number().int() });

// v1 — 큐 잔존 job / 기존 fixture 호환용. Task 6 전까지는 신규 enqueue도 v1.
export const ModelsSchemaV1 = z.object({
  whisper_model: z.enum(['large-v3-turbo', 'large-v3']),
  device: z.enum(['mps', 'cpu', 'cuda']),
  language: z.string(),
  diarization: DiarizationSchema,
  embedding: EmbeddingSchema,
});

export const ModelsSchemaV2 = z
  .object({
    whisper_model: z.enum(WHISPER_MODELS),
    language: z.string(),
    devices: z.object({ diarization: DeviceSchema, stt: DeviceSchema }),
    preset: z.enum(['light', 'standard', 'quality', 'custom']),
    preset_revision: z.string().nullable(),
    diarization: DiarizationSchema,
    embedding: EmbeddingSchema,
  })
  .strict(); // legacy `device` 혼입 차단

const processMeetingCommon = {
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  audio_key: z.string().min(1),
  processing_version: z.number().int().nonnegative(),
  reprocess: z.boolean(),
  identify: z.object({ threshold: z.number() }),
};
const ProcessMeetingPayloadV1Schema = z.object({
  schema_version: z.literal(1), ...processMeetingCommon, models: ModelsSchemaV1,
});
const ProcessMeetingPayloadV2Schema = z.object({
  schema_version: z.literal(2), ...processMeetingCommon, models: ModelsSchemaV2,
});

// zod discriminatedUnion은 child의 .default()를 discriminator 선택 전에 적용하지
// 않으므로, version 누락 payload는 preprocess로 v1에 귀속시킨다 (spec §4).
export const ProcessMeetingPayloadSchema = z.preprocess(
  (v) =>
    v !== null && typeof v === 'object' && (v as Record<string, unknown>).schema_version === undefined
      ? { ...(v as object), schema_version: 1 }
      : v,
  z.discriminatedUnion('schema_version', [ProcessMeetingPayloadV1Schema, ProcessMeetingPayloadV2Schema]),
);

export const EnrollSpeakerPayloadSchema = z.object({
  schema_version: z.literal(1).default(1),
  speaker_id: z.string().regex(/^spk_[1-9][0-9]*$/),
  audio_key: z.string().min(1),
  embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});

export const IndexMeetingPayloadSchema = z.object({
  schema_version: z.literal(1).default(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  processing_version: z.number().int().nonnegative(),
  search_embedding: z.object({ model: z.string(), dimension: z.literal(1024) }),
});

export const ExtractLensesPayloadSchema = z.object({
  schema_version: z.literal(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  processing_version: z.number().int().nonnegative(),
  extraction_run_id: z.string().regex(/^ler_[1-9][0-9]*$/),
  model: z.string().min(1),
}).strict();

// 렌즈와 달리 extraction_run_id가 없다 — meeting_summary는 회의당 1행이라
// meeting_id가 곧 키이고 별도 run 엔티티가 필요 없다.
export const SummarizeMeetingPayloadSchema = z.object({
  schema_version: z.literal(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  processing_version: z.number().int().nonnegative(),
  model: z.string().min(1),
}).strict();

export type ProcessMeetingPayloadV1 = z.infer<typeof ProcessMeetingPayloadV1Schema>;
export type ProcessMeetingPayloadV2 = z.infer<typeof ProcessMeetingPayloadV2Schema>;
export type ProcessMeetingPayload = z.infer<typeof ProcessMeetingPayloadSchema>;
export type EnrollSpeakerPayload = z.infer<typeof EnrollSpeakerPayloadSchema>;
export type IndexMeetingPayload = z.infer<typeof IndexMeetingPayloadSchema>;
export type ExtractLensesPayload = z.infer<typeof ExtractLensesPayloadSchema>;
export type SummarizeMeetingPayload = z.infer<typeof SummarizeMeetingPayloadSchema>;

export function buildProcessMeetingPayload(args: {
  meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean;
  processing: ProcessingConfig;
}): ProcessMeetingPayloadV2 {
  const env = loadEnv();
  const p = args.processing;
  return {
    schema_version: 2,
    meeting_id: args.meetingId,
    audio_key: args.audioKey,
    processing_version: args.processingVersion,
    reprocess: args.reprocess,
    models: {
      whisper_model: p.whisper_model,
      language: p.language,
      devices: p.devices,
      preset: p.preset,
      preset_revision: p.preset_revision,
      diarization: { model: env.DIARIZATION_MODEL, min_speakers: null, max_speakers: null },
      embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
    },
    identify: { threshold: env.IDENTIFY_THRESHOLD },
  };
}

export function buildEnrollSpeakerPayload(args: {
  speakerId: string; audioKey: string;
}): EnrollSpeakerPayload {
  const env = loadEnv();
  return {
    schema_version: 1,
    speaker_id: args.speakerId,
    audio_key: args.audioKey,
    embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
  };
}

export function buildIndexMeetingPayload(args: {
  meetingId: string; processingVersion: number;
}): IndexMeetingPayload {
  const env = loadEnv();
  return {
    schema_version: 1,
    meeting_id: args.meetingId,
    processing_version: args.processingVersion,
    search_embedding: { model: env.SEARCH_EMBEDDING_MODEL, dimension: env.SEARCH_EMBEDDING_DIM },
  };
}

export function buildExtractLensesPayload(args: {
  meetingId: string; processingVersion: number; extractionRunId: string; model: string;
}): ExtractLensesPayload {
  return {
    schema_version: 1,
    meeting_id: args.meetingId,
    processing_version: args.processingVersion,
    extraction_run_id: args.extractionRunId,
    model: args.model,
  };
}

export function buildSummarizeMeetingPayload(args: {
  meetingId: string; processingVersion: number; model: string;
}): SummarizeMeetingPayload {
  return {
    schema_version: 1,
    meeting_id: args.meetingId,
    processing_version: args.processingVersion,
    model: args.model,
  };
}
