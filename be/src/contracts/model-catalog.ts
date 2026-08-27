/**
 * 요약 LLM 모델 카탈로그 — import가 없는 잎 모듈.
 *
 * env.ts / job-payload.schema.ts / settings/* 세 곳이 이 목록을 쓴다.
 * job-payload.schema.ts는 env.ts의 loadEnv를 import하므로, 목록을 그쪽에 두면
 * env.ts → job-payload.schema.ts → env.ts 순환이 생긴다. 그래서 별도 파일이다.
 * (env.ts:9의 WHISPER_MODEL enum 중복도 같은 제약의 흔적 — 그쪽은 건드리지 않는다.)
 *
 * 값 자체는 이제 `@damwha/contracts`가 갖는다 — FE가 같은 목록을 손으로
 * 미러링하다 2026-08-12에 어긋난 적이 있어서, 모노레포 통합 후 공유 패키지로
 * 옮겼다. 이 파일은 기존 import 경로를 지키는 재수출층이다.
 */
export { SUMMARY_MODELS } from '@damwha/contracts';
export type { SummaryModel } from '@damwha/contracts';
