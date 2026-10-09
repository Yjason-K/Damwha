import { z } from 'zod';
import { SUMMARY_MODELS } from '../contracts/model-catalog';
import { SUMMARY_LANGUAGES } from '@damwha/contracts';
import { parseAllowedHosts, parseAllowedOrigins } from '../access/access-policy';
import { parseShareApiUrl } from '../shares/share-api-url';

/** 파서가 throw하면 그 메시지로 zod 이슈를 만든다 — 기동 실패 메시지에 env 이름이 남는다. */
const validatedBy = (parse: (raw: string) => unknown) => (raw: string, ctx: z.RefinementCtx) => {
  try {
    parse(raw);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
  }
};

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  // 기본은 loopback이다(spec 2026-10-08 §3.5) — pnpm dev가 API를 LAN에 열던 0.0.0.0을 버린다.
  // 바깥에서 닿아야 하는 컨테이너는 deploy/api.Dockerfile이 ENV HOST=0.0.0.0을 준다.
  // desktop은 그와 무관하게 127.0.0.1을 마지막에 덮어쓴다(desktop/src/services/api-process.ts).
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string(),
  STORAGE_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(1_073_741_824),
  REAPER_STALE_MINUTES: z.coerce.number().default(30),
  // 앱(Electron)이 자식 env에 얹는 이번 실행의 worker 신분. 기본값을 두지 않는다 —
  // **없음이 곧 "앱이 띄운 API가 아니다"**라는 신호이고, 그때 기동 회수는 돌지 않는다.
  WORKER_ID: z.string().optional(),
  WHISPER_MODEL: z.enum(['large-v3-turbo', 'large-v3']).default('large-v3-turbo'),
  WHISPER_DEVICE: z.enum(['mps', 'cpu', 'cuda']).default('mps'),
  STT_LANGUAGE: z.string().default('ko'),
  // speaker-diarization-3.1 is broken under the installed pyannote.audio 4.x:
  // segmentation is fine but clustering collapses every speaker into one label
  // (measured on mtg_5 — 105 utterances on one label vs 3 on the other for a
  // two-person interview; same turn boundaries, correct 2-way split under
  // community-1). community-1 is pyannote 4.x's own diarization pipeline.
  DIARIZATION_MODEL: z.string().default('pyannote/speaker-diarization-community-1'),
  EMBEDDING_MODEL: z.string().default('speechbrain/spkrec-ecapa-voxceleb'),
  EMBEDDING_DIM: z.coerce.number().default(192),
  // Two-tier identification. At/above IDENTIFY_THRESHOLD a cluster binds to the
  // matched speaker; down to IDENTIFY_SUGGEST_THRESHOLD it only records the
  // candidate for the user to confirm. Defaults are set from the local eval
  // (`worker/scripts/eval_speaker_id.py --halves`): different-speaker centroid
  // pairs topped out at 0.71 and same-speaker half-splits floored at 0.97, so 0.80
  // binds with margin over every observed negative while 0.60 keeps the ambiguous
  // band visible instead of silently merging it. Retune with the eval, not by feel.
  IDENTIFY_THRESHOLD: z.coerce.number().default(0.8),
  IDENTIFY_SUGGEST_THRESHOLD: z.coerce.number().default(0.6),
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
  LENS_LLM_MODEL: z.string().default('mlx-community/Qwen3.5-4B-8bit'),
  // 목록 밖 값이면 API가 시작에 실패한다 — 의도된 breaking change (spec §2).
  // 조용히 목록 안 값으로 강등하면 "고른 적 없는 모델로 요약"이 된다.
  SUMMARY_LLM_MODEL: z.enum(SUMMARY_MODELS).default('mlx-community/Qwen3.5-4B-8bit'),
  // 요약·렌즈 출력 언어의 기본값(다국어 스펙 §3.2·§5.1). 저장된 처리 설정에 값이 없을 때만 쓴다.
  // desktop이 API를 띄울 때 기기 언어(ko/en)를 넣는다 — 그래서 사람이 고르기 전에는 기기 언어를 따른다.
  // desktop 없이 띄우면 transcript(녹취 언어 따름) — 이 설정이 생기기 전의 동작이다.
  // 목록 밖 값이면 기동 실패(SUMMARY_LLM_MODEL과 같은 이유).
  SUMMARY_LANGUAGE: z.enum(SUMMARY_LANGUAGES).default('transcript'),
  // 공개 데모 읽기 전용 스위치(설계 §3.6). 가드는 process.env를 직접 읽는다 — 여기는 문서화용.
  DEMO_READ_ONLY: z.enum(['true', 'false']).default('false'),
  // 로컬 API 접근 제어(spec 2026-10-08 §3.4). 같은 origin 말고 /api를 부를 수 있는 Origin(쉼표 구분,
  // 정확히 일치)과, loopback 말고 허용할 Host 이름. 비우면 같은 origin·loopback만.
  ALLOWED_ORIGINS: z.string().default('').superRefine(validatedBy(parseAllowedOrigins)),
  ALLOWED_HOSTS: z.string().default('').superRefine(validatedBy(parseAllowedHosts)),
  // 공유 서버(share/, 개인 서버 + Cloudflare Tunnel)의 origin (spec selfhost-v2 §2.4·§2.7). 개발은 be/.env의
  // http://localhost:8787. 기본값이 운영 주소라 packaged 앱은 따로 넘기지 않는다 — desktop은 상속 env의 값을 지운다.
  SHARE_API_URL: z.string().default('https://damwha-share.0kimjae.dev').superRefine(validatedBy(parseShareApiUrl)),
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
