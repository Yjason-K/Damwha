/**
 * 요약 LLM 모델 카탈로그 — import가 없는 잎 모듈.
 *
 * env.ts / job-payload.schema.ts / settings/* 세 곳이 이 목록을 쓴다.
 * job-payload.schema.ts는 env.ts의 loadEnv를 import하므로, 목록을 그쪽에 두면
 * env.ts → job-payload.schema.ts → env.ts 순환이 생긴다. 그래서 별도 파일이다.
 * (env.ts:9의 WHISPER_MODEL enum 중복도 같은 제약의 흔적 — 그쪽은 건드리지 않는다.)
 */
// 값은 LLM 서버가 그대로 받는 이름이다. mlx_lm.server는 요청의 model을 HF repo id로
// 해석하므로(별칭을 걸 방법이 없다 — SMOKE.md) 카탈로그도 repo id로 적는다.
export const SUMMARY_MODELS = [
  'mlx-community/Qwen3.5-4B-8bit',
  'mlx-community/Qwen3.5-9B-8bit',
  'mlx-community/Qwen3.5-27B-8bit',
] as const;
export type SummaryModel = (typeof SUMMARY_MODELS)[number];
