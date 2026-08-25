import { z } from 'zod';

// 회의별 화자 수 힌트 — pyannote의 min/max_speakers로 그대로 흘러간다. 처리 설정
// 오버라이드(ProcessingOverride)와 분리한 이유: 화자 수는 회의의 속성이지 파이프라인
// 설정이 아니라서, 주더라도 preset이 custom으로 바뀌면 안 된다.
// 상한 20은 pyannote가 아니라 제품 판단 — 그 이상은 힌트가 아니라 오입력이다.
const bound = z.number().int().min(1).max(20);
export const SpeakerBoundsSchema = z
  .object({ min: bound.optional(), max: bound.optional() })
  .strict()
  .refine((b) => b.min !== undefined || b.max !== undefined, 'speakers must set min or max')
  .refine((b) => b.min === undefined || b.max === undefined || b.min <= b.max,
          'speakers.min must be <= speakers.max');
export type SpeakerBounds = z.infer<typeof SpeakerBoundsSchema>;
