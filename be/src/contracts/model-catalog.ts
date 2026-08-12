/**
 * 요약 LLM 모델 카탈로그 — import가 없는 잎 모듈.
 *
 * env.ts / job-payload.schema.ts / settings/* 세 곳이 이 목록을 쓴다.
 * job-payload.schema.ts는 env.ts의 loadEnv를 import하므로, 목록을 그쪽에 두면
 * env.ts → job-payload.schema.ts → env.ts 순환이 생긴다. 그래서 별도 파일이다.
 * (env.ts:9의 WHISPER_MODEL enum 중복도 같은 제약의 흔적 — 그쪽은 건드리지 않는다.)
 */
export const SUMMARY_MODELS = ['qwen3.5:4b-mlx', 'qwen3.5:9b-mlx', 'qwen3.5:27b-mlx'] as const;
export type SummaryModel = (typeof SUMMARY_MODELS)[number];
