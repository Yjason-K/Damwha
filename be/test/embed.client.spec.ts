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

  it('returns the vector on a 200 with matching dimension', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    process.env.SEARCH_EMBEDDING_DIM = '3';
    const c = new EmbedClient();
    // fetch를 stub: 정상 응답
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'BAAI/bge-m3', dimension: 3, vectors: [[0.1, 0.2, 0.3]] }),
    });
    expect(await c.embed('hello')).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns null when dimension mismatches config', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    process.env.SEARCH_EMBEDDING_DIM = '1024';
    const c = new EmbedClient();
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'x', dimension: 3, vectors: [[0.1, 0.2, 0.3]] }),
    });
    expect(await c.embed('hello')).toBeNull();
  });
});
