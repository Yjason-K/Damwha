import { loadEnv } from '../src/config/env';

describe('loadEnv HOST', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved, DATABASE_URL: 'postgres://u:p@localhost:5432/d' };
  });
  afterAll(() => {
    process.env = saved;
  });

  it('defaults to 127.0.0.1 — the Docker image sets HOST=0.0.0.0 itself', () => {
    delete process.env.HOST;
    expect(loadEnv().HOST).toBe('127.0.0.1');
  });

  it('takes the injected value', () => {
    process.env.HOST = '127.0.0.1';
    expect(loadEnv().HOST).toBe('127.0.0.1');
  });
});

describe('loadEnv access lists', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved, DATABASE_URL: 'postgres://u:p@localhost:5432/d' };
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOWED_HOSTS;
  });
  afterAll(() => { process.env = saved; });

  it('defaults both lists to empty', () => {
    const env = loadEnv();
    expect(env.ALLOWED_ORIGINS).toBe('');
    expect(env.ALLOWED_HOSTS).toBe('');
  });

  it('accepts bare origins and host names', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173, http://127.0.0.1:5173';
    process.env.ALLOWED_HOSTS = 'damwha-demo.0kimjae.dev';
    expect(() => loadEnv()).not.toThrow();
  });

  it.each([
    'http://localhost:5173/',      // 끝 슬래시
    'http://localhost:5173/app',   // 경로
    'localhost:5173',              // scheme 없음
    '*',
    'null',
    'HTTP://LOCALHOST:5173',       // 정규형이 아님
  ])('rejects ALLOWED_ORIGINS=%s at startup', (bad) => {
    process.env.ALLOWED_ORIGINS = bad;
    expect(() => loadEnv()).toThrow(/ALLOWED_ORIGINS/);
  });

  it.each(['demo.example:443', 'https://demo.example', '*.example', '*', 'a b'])(
    'rejects ALLOWED_HOSTS=%s at startup', (bad) => {
      process.env.ALLOWED_HOSTS = bad;
      expect(() => loadEnv()).toThrow(/ALLOWED_HOSTS/);
    },
  );
});
