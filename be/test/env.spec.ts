import { loadEnv } from '../src/config/env';

describe('loadEnv HOST', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved, DATABASE_URL: 'postgres://u:p@localhost:5432/d' };
  });
  afterAll(() => {
    process.env = saved;
  });

  it('defaults to 0.0.0.0 so the Docker image keeps working', () => {
    delete process.env.HOST;
    expect(loadEnv().HOST).toBe('0.0.0.0');
  });

  it('takes the injected value', () => {
    process.env.HOST = '127.0.0.1';
    expect(loadEnv().HOST).toBe('127.0.0.1');
  });
});
