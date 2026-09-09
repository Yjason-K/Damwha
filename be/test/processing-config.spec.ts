import {
  PutProcessingValueSchema,
  StoredProcessingValueSchema,
} from '../src/settings/processing-config';

const CUSTOM = {
  preset: 'custom' as const,
  whisper_model: 'large-v3-turbo' as const,
  devices: { diarization: 'gpu' as const, stt: 'gpu' as const },
  summary_model: 'mlx-community/Qwen3.5-9B-8bit' as const,
};

describe('PutProcessingValueSchema — language', () => {
  it('목록 안 언어를 받는다', () => {
    expect(PutProcessingValueSchema.safeParse({ ...CUSTOM, language: 'en' }).success).toBe(true);
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'ja' }).success).toBe(true);
  });

  it('auto를 받는다 — 워커가 whisper 자동 감지로 넘긴다', () => {
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'auto' }).success).toBe(true);
  });

  it('목록 밖 언어를 거부한다 — 자유 텍스트가 whisper에 그대로 새던 경로 차단', () => {
    expect(PutProcessingValueSchema.safeParse({ ...CUSTOM, language: 'kor' }).success).toBe(false);
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: '한국어' }).success).toBe(false);
  });
});

describe('StoredProcessingValueSchema — language', () => {
  it('목록 밖 언어도 읽는다 — 조이기 전 저장된 행과 env 폴백을 깨지 않는다', () => {
    expect(StoredProcessingValueSchema.safeParse({ preset: 'light', language: 'kor' }).success).toBe(true);
    expect(StoredProcessingValueSchema.safeParse({ ...CUSTOM, language: 'fr' }).success).toBe(true);
  });

  it('빈 언어는 여전히 거부한다', () => {
    expect(StoredProcessingValueSchema.safeParse({ preset: 'light', language: '' }).success).toBe(false);
  });
});
