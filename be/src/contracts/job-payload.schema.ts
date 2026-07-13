import { z } from 'zod';
import { loadEnv } from '../config/env';

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

export type ProcessMeetingPayloadV1 = z.infer<typeof ProcessMeetingPayloadV1Schema>;
export type ProcessMeetingPayloadV2 = z.infer<typeof ProcessMeetingPayloadV2Schema>;
export type ProcessMeetingPayload = z.infer<typeof ProcessMeetingPayloadSchema>;
export type EnrollSpeakerPayload = z.infer<typeof EnrollSpeakerPayloadSchema>;
export type IndexMeetingPayload = z.infer<typeof IndexMeetingPayloadSchema>;

export function buildProcessMeetingPayload(args: {
  meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean;
}): ProcessMeetingPayloadV1 {
  const env = loadEnv();
  return {
    schema_version: 1,
    meeting_id: args.meetingId,
    audio_key: args.audioKey,
    processing_version: args.processingVersion,
    reprocess: args.reprocess,
    models: {
      whisper_model: env.WHISPER_MODEL,
      device: env.WHISPER_DEVICE,
      language: env.STT_LANGUAGE,
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
