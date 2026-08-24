import { EmbedClient } from '../src/search/embed.client';

describe('EmbedClient', () => {
  const OLD = { ...process.env };
  const OLD_FETCH = global.fetch;
  beforeEach(() => {
    // loadEnv() requires DATABASE_URL; provide a dummy for this unit test
    process.env.DATABASE_URL ??= 'postgres://localhost/test';
  });
  afterEach(() => { process.env = { ...OLD }; global.fetch = OLD_FETCH; });

  it('rejects a non-loopback embed URL at construction', () => {
    process.env.EMBED_SERVICE_URL = 'http://10.0.0.5:8100';
    process.env.EMBED_SERVICE_ALLOW_NON_LOOPBACK = 'false';
    expect(() => new EmbedClient()).toThrow(/loopback/i);
  });

  it('allows non-loopback with explicit override', () => {
    process.env.EMBED_SERVICE_URL = 'http://10.0.0.5:8100';
    process.env.EMBED_SERVICE_ALLOW_NON_LOOPBACK = 'true';
    expect(() => new EmbedClient()).not.toThrow();
  });

  it('returns null (degrade) when service is unreachable', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:1'; // nothing listening
    process.env.EMBED_SERVICE_TIMEOUT_MS = '200';
    const c = new EmbedClient();
    expect(await c.embed('hello')).toBeNull();
  });

  // Phase 2는 1024차원 고정(SEARCH_EMBEDDING_DIM literal 1024) → 픽스처도 1024차원.
  const vec1024 = (fill = 0.01) => Array(1024).fill(fill) as number[];

  it('returns the vector on a 200 with matching model + dimension', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    const v = Array.from({ length: 1024 }, (_, i) => i / 1024);
    const c = new EmbedClient();
    // fetch를 stub: 정상 응답 (model=BAAI/bge-m3, dim=1024, 벡터 1개)
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'BAAI/bge-m3', dimension: 1024, vectors: [v] }),
    });
    expect(await c.embed('hello')).toEqual(v);
  });

  it('returns null when dimension mismatches config', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    const c = new EmbedClient();
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'BAAI/bge-m3', dimension: 3, vectors: [[0.1, 0.2, 0.3]] }),
    });
    expect(await c.embed('hello')).toBeNull();
  });

  it('returns null (degrade) when the response model differs', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    const c = new EmbedClient();
    // 같은 1024차원이라도 다른 모델 → 다른 벡터공간 → degrade
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'sentence-transformers/other', dimension: 1024, vectors: [vec1024()] }),
    });
    expect(await c.embed('hello')).toBeNull();
  });

  it('returns null when the vector has NaN/Infinity', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    const c = new EmbedClient();
    const bad = vec1024();
    bad[0] = NaN;
    bad[1] = Infinity;
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'BAAI/bge-m3', dimension: 1024, vectors: [bad] }),
    });
    expect(await c.embed('hello')).toBeNull();
  });

  it('returns null when the response has more than one vector', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    const c = new EmbedClient();
    const v = vec1024();
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'BAAI/bge-m3', dimension: 1024, vectors: [v, v] }),
    });
    expect(await c.embed('hello')).toBeNull();
  });
});
