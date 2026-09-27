import {
  PutProcessingValueSchema,
  StoredProcessingValueSchema,
  resolveStoredValue,
} from '../src/settings/processing-config';

const CUSTOM = {
  preset: 'custom' as const,
  whisper_model: 'large-v3-turbo' as const,
  devices: { diarization: 'gpu' as const, stt: 'gpu' as const },
  summary_model: 'mlx-community/Qwen3.5-9B-8bit' as const,
};

describe('PutProcessingValueSchema — language', () => {
  it('목록 안 언어를 받는다', () => {
    expect(PutProcessingValueSchema.safeParse(
      { ...CUSTOM, language: 'en', summary_language: 'transcript' },
    ).success).toBe(true);
    expect(PutProcessingValueSchema.safeParse(
      { preset: 'light', language: 'ja', summary_language: 'transcript' },
    ).success).toBe(true);
  });

  it('auto를 받는다 — 워커가 whisper 자동 감지로 넘긴다', () => {
    expect(PutProcessingValueSchema.safeParse(
      { preset: 'light', language: 'auto', summary_language: 'transcript' },
    ).success).toBe(true);
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

describe('summary_language', () => {
  const env0 = process.env.SUMMARY_LANGUAGE;
  beforeAll(() => { process.env.DATABASE_URL ??= 'postgres://localhost/test'; });
  afterEach(() => {
    if (env0 === undefined) delete process.env.SUMMARY_LANGUAGE;
    else process.env.SUMMARY_LANGUAGE = env0;
  });

  it('PUT은 두 모양 모두 summary_language를 요구한다', () => {
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'ko' }).success).toBe(false);
    expect(PutProcessingValueSchema.safeParse({ ...CUSTOM, language: 'ko' }).success).toBe(false);
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'ko', summary_language: 'en' }).success).toBe(true);
    expect(PutProcessingValueSchema.safeParse({ ...CUSTOM, language: 'ko', summary_language: 'transcript' }).success).toBe(true);
  });

  it('PUT은 목록 밖 값을 거부한다', () => {
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'ko', summary_language: 'ja' }).success).toBe(false);
  });

  it('저장값에 없으면 env SUMMARY_LANGUAGE, env도 없으면 transcript', () => {
    delete process.env.SUMMARY_LANGUAGE;
    expect(resolveStoredValue({ preset: 'light', language: 'ko' }).summary_language).toBe('transcript');
    process.env.SUMMARY_LANGUAGE = 'en';
    expect(resolveStoredValue({ preset: 'light', language: 'ko' }).summary_language).toBe('en');
    expect(resolveStoredValue({ ...CUSTOM, language: 'ko' }).summary_language).toBe('en');
  });

  it('저장값이 있으면 env보다 저장값', () => {
    process.env.SUMMARY_LANGUAGE = 'en';
    expect(resolveStoredValue({ preset: 'light', language: 'ko', summary_language: 'ko' }).summary_language).toBe('ko');
    expect(resolveStoredValue({ ...CUSTOM, language: 'ko', summary_language: 'transcript' }).summary_language).toBe('transcript');
  });
});
