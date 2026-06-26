import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  STORAGE_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(1_073_741_824),
  REAPER_STALE_MINUTES: z.coerce.number().default(30),
  WHISPER_MODEL: z.enum(['large-v3-turbo', 'large-v3']).default('large-v3-turbo'),
  WHISPER_DEVICE: z.enum(['mps', 'cpu', 'cuda']).default('mps'),
  STT_LANGUAGE: z.string().default('ko'),
  DIARIZATION_MODEL: z.string().default('pyannote/speaker-diarization-3.1'),
  EMBEDDING_MODEL: z.string().default('speechbrain/spkrec-ecapa-voxceleb'),
  EMBEDDING_DIM: z.coerce.number().default(192),
  IDENTIFY_THRESHOLD: z.coerce.number().default(0.7),
  SEARCH_EMBEDDING_MODEL: z.string().default('BAAI/bge-m3'),
  SEARCH_EMBEDDING_DIM: z.coerce.number().default(1024),
});

export type Env = z.infer<typeof EnvSchema>;
export function loadEnv(): Env {
  return EnvSchema.parse(process.env);
}
export const ENV = new Proxy({} as Env, {
  get: (_t, prop: string) => loadEnv()[prop as keyof Env],
});

// Narrow reader used in decorator/module metadata (evaluated at import time,
// BEFORE tests set DATABASE_URL). MUST NOT call loadEnv() — parsing the full
// schema there would throw on the missing DATABASE_URL during module import.
export function maxUploadBytes(): number {
  const v = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 1_073_741_824;
}
