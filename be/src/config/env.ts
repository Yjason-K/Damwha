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
  // Phase 2는 임베딩 차원을 1024로 고정(utterance_embedding.embedding = vector(1024)).
  // 오설정으로 색인 잡이 영구 실패하지 않도록 literal 1024만 허용.
  SEARCH_EMBEDDING_DIM: z.coerce
    .number()
    .int()
    .default(1024)
    .refine((n) => n === 1024, 'SEARCH_EMBEDDING_DIM must be 1024 in Phase 2'),
  EMBED_SERVICE_URL: z.string().default('http://127.0.0.1:8100'),
  EMBED_SERVICE_TIMEOUT_MS: z.coerce.number().default(800),
  EMBED_SERVICE_ALLOW_NON_LOOPBACK: z.string().default('false'),
  SEARCH_RRF_K: z.coerce.number().default(60),
  SEARCH_CANDIDATE_K: z.coerce.number().default(100),
  LENS_LLM_MODEL: z.string().default('qwen3.5:4b-mlx'),
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
