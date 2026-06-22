import { z } from 'zod';
import { loadEnv } from '../config/env';

export const ModelsSchema = z.object({
  whisper_model: z.enum(['large-v3-turbo', 'large-v3']),
  device: z.enum(['mps', 'cpu', 'cuda']),
  language: z.string(),
  diarization: z.object({
    model: z.string(),
    min_speakers: z.number().int().nullable(),
    max_speakers: z.number().int().nullable(),
  }),
  embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});

export const ProcessMeetingPayloadSchema = z.object({
  meeting_id: z.string().uuid(),
  audio_key: z.string().min(1),
  processing_version: z.number().int().nonnegative(),
  reprocess: z.boolean(),
  models: ModelsSchema,
  identify: z.object({ threshold: z.number() }),
});

export const EnrollSpeakerPayloadSchema = z.object({
  speaker_id: z.string().uuid(),
  audio_key: z.string().min(1),
  embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});

export type ProcessMeetingPayload = z.infer<typeof ProcessMeetingPayloadSchema>;
export type EnrollSpeakerPayload = z.infer<typeof EnrollSpeakerPayloadSchema>;

export function buildProcessMeetingPayload(args: {
  meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean;
}): ProcessMeetingPayload {
  const env = loadEnv();
  return {
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
    speaker_id: args.speakerId,
    audio_key: args.audioKey,
    embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
  };
}
