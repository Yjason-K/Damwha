import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARE_MAX_ENVELOPE_BYTES, newDeleteToken, newShareId } from '@damwha/share-format';
import { createApp } from '../src/app.js';
import { readConfig, type ShareConfig } from '../src/config.js';
import { DiskStore } from '../src/store.js';

const ORIGIN = 'https://damwha-share.example';
const IP = { ip: '203.0.113.9' };
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
let dir: string;
let store: DiskStore;
let clock: Date;
let logs: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-app-'));
  store = new DiskStore(dir);
  await store.init();
  clock = new Date('2026-10-09T03:00:00.000Z');
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeApp(over: Partial<ShareConfig> = {}) {
  const config = { ...readConfig({}), dataDir: dir, ...over };
  return createApp({ store, config, now: () => clock, viewerDir: null, log: (l) => logs.push(l) });
}
type App = ReturnType<typeof makeApp>;
type Up = { id: string; token: string; res: Response };
/** be처럼 id·토큰을 만들어 올린다. */
async function upload(
  app: App,
  o: { body?: Uint8Array<ArrayBuffer>; days?: 1 | 7 | 30; id?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<Up> {
  const days = o.days ?? 7;
  const id = o.id ?? newShareId(days);
  const token = o.token ?? newDeleteToken();
  const res = await app.fetch(
    new Request(`${ORIGIN}/api/shares`, {
      method: 'POST',
      headers: { 'X-Share-Days': String(days), 'X-Share-Id': id, 'X-Delete-Token': token, ...o.headers },
      body: o.body ?? bytes(64),
    }),
    IP,
  );
  return { id, token, res };
}
const get = (app: App, id: string) => app.fetch(new Request(`${ORIGIN}/api/shares/${id}`), IP);
const del = (app: App, id: string, token?: string) =>
  app.fetch(new Request(`${ORIGIN}/api/shares/${id}`, { method: 'DELETE', headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } }), IP);
type Created = { id: string; expires_at: string; replaced: boolean };
const jsonFiles = () => readdirSync(join(dir, 'shares')).filter((f) => f.endsWith('.json'));

describe('업로드', () => {
  it('be가 준 id로 저장하고 만료 시각을 돌려준다 — 토큰은 응답에 없다', async () => {
    const { id, res } = await upload(makeApp());
    expect(res.status).toBe(201);
    const b = (await res.json()) as Created & { delete_token?: string };
    expect(b).toEqual({ id, expires_at: '2026-10-16T03:00:00.000Z', replaced: false });
  });

  it('디스크에 토큰 원문이 남지 않는다', async () => {
    const { id, token } = await upload(makeApp());
    expect(readFileSync(join(dir, 'shares', `${id}.json`), 'utf8')).not.toContain(token);
  });

  it('같은 id·토큰으로 다시 올리면 아무것도 바꾸지 않고 200으로 같은 결과 (응답 유실 뒤 재시도)', async () => {
    const app = makeApp();
    const first = await upload(app, { body: bytes(8, 1) });
    const firstBody = (await first.res.json()) as Created;
    clock = new Date(clock.getTime() + 60_000);
    const again = await upload(app, { id: first.id, token: first.token, body: bytes(8, 2) });
    expect(again.res.status).toBe(200);
    expect(await again.res.json()).toEqual(firstBody);
    expect(new Uint8Array(await (await get(app, first.id)).arrayBuffer())).toEqual(bytes(8, 1));
  });

  it('같은 id인데 토큰이 다르면 409 ID_TAKEN이고 기존 공유를 건드리지 않는다', async () => {
    const app = makeApp();
    const first = await upload(app);
    const res = (await upload(app, { id: first.id, token: newDeleteToken() })).res;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ID_TAKEN' });
    expect((await del(app, first.id, first.token)).status).toBe(204);
  });

  it('id·토큰 형식이 틀리거나 id의 기간이 헤더와 다르면 400 BAD_ID', async () => {
    const app = makeApp();
    for (const o of [{ id: '../x' }, { id: newShareId(1) }, { token: 'short' }, { id: '' }]) {
      const res = (await upload(app, { days: 7, ...o })).res;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'BAD_ID' });
    }
    expect(jsonFiles()).toEqual([]);
  });

  it('기간이 목록 밖이면 400 BAD_DURATION', async () => {
    for (const d of ['0', '2', '31', '', 'abc']) {
      const res = (await upload(makeApp(), { headers: { 'X-Share-Days': d } })).res;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'BAD_DURATION' });
    }
  });

  it('빈 본문은 400', async () => {
    expect((await upload(makeApp(), { body: new Uint8Array(0) })).res.status).toBe(400);
  });

  it('상한을 넘는 본문은 413이고 아무것도 쓰지 않는다', async () => {
    expect((await upload(makeApp(), { body: bytes(SHARE_MAX_ENVELOPE_BYTES + 1) })).res.status).toBe(413);
    expect(readdirSync(join(dir, 'shares'))).toEqual([]);
  });
});

describe('조회', () => {
  it('올린 바이트와 만료 시각 헤더', async () => {
    const app = makeApp();
    const { id, res: up } = await upload(app, { body: bytes(32, 9) });
    const b = (await up.json()) as Created;
    const res = await get(app, id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-share-expires-at')).toBe(b.expires_at);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(32, 9));
  });

  it('형식이 맞지만 없는 id는 410, 형식이 틀리면 404', async () => {
    const app = makeApp();
    expect((await get(app, newShareId(7))).status).toBe(410);
    expect((await get(app, '..%2Fshares%2Fx')).status).toBe(404);
    expect((await get(app, '7-short')).status).toBe(404);
  });

  it('만료 시각이 지나면 410 — 스위퍼를 기다리지 않는다', async () => {
    const app = makeApp();
    const { id, res } = await upload(app);
    clock = new Date(Date.parse(((await res.json()) as Created).expires_at));
    expect((await get(app, id)).status).toBe(410);
  });
});

describe('삭제', () => {
  it('맞는 토큰이면 204, 이후 조회 410, 다시 지우면 404', async () => {
    const app = makeApp();
    const { id, token } = await upload(app);
    expect((await del(app, id, token)).status).toBe(204);
    expect((await get(app, id)).status).toBe(410);
    expect((await del(app, id, token)).status).toBe(404);
  });

  it('틀린 토큰·토큰 없음은 403이고 지우지 않는다', async () => {
    const app = makeApp();
    const { id } = await upload(app);
    expect((await del(app, id, 'wrong')).status).toBe(403);
    expect((await del(app, id)).status).toBe(403);
    expect((await get(app, id)).status).toBe(200);
  });
});

describe('교체 (spec selfhost-v2 §2.4)', () => {
  const replaceHeaders = (old: Up) => ({ 'X-Replace-Id': old.id, 'X-Replace-Token': old.token });

  it('맞는 토큰이면 새 공유가 생기고, 응답 시점에 기존 공유는 이미 410이다', async () => {
    const app = makeApp();
    const old = await upload(app);
    const fresh = await upload(app, { body: bytes(16), headers: replaceHeaders(old) });
    expect(fresh.res.status).toBe(201);
    expect(((await fresh.res.json()) as Created).replaced).toBe(true);
    expect((await get(app, old.id)).status).toBe(410);
    expect((await get(app, fresh.id)).status).toBe(200);
  });

  it('토큰이 틀리면 403이고 새 공유를 만들지 않으며 기존 공유는 그대로다', async () => {
    const app = makeApp();
    const old = await upload(app);
    const res = (await upload(app, { body: bytes(16), headers: { 'X-Replace-Id': old.id, 'X-Replace-Token': 'wrong' } })).res;
    expect(res.status).toBe(403);
    expect(jsonFiles()).toEqual([`${old.id}.json`]);
    expect((await get(app, old.id)).status).toBe(200);
  });

  it('기존 공유가 이미 없으면 그냥 새로 만들고 replaced=false', async () => {
    const res = (await upload(makeApp(), { headers: { 'X-Replace-Id': newShareId(7), 'X-Replace-Token': 't' } })).res;
    expect(res.status).toBe(201);
    expect(((await res.json()) as Created).replaced).toBe(false);
  });

  it('같은 기존 링크의 교체가 동시에 오면 하나만 되고 나머지는 409 REPLACE_IN_PROGRESS', async () => {
    const app = makeApp();
    const old = await upload(app);
    const [a, b] = await Promise.all([
      upload(app, { headers: replaceHeaders(old) }),
      upload(app, { headers: replaceHeaders(old) }),
    ]);
    expect([a.res.status, b.res.status].sort()).toEqual([201, 409]);
    expect(jsonFiles()).toHaveLength(1);
  });

  it('기존 공유를 못 지우면 500이고 새 공유도 남기지 않는다', async () => {
    const app = makeApp();
    const old = await upload(app);
    const realDelete = store.delete.bind(store);
    store.delete = async (id) => {
      if (id === old.id) throw new Error('EBUSY');
      return realDelete(id);
    };
    const fresh = await upload(app, { headers: replaceHeaders(old) });
    expect(fresh.res.status).toBe(500);
    expect((await get(app, fresh.id)).status).toBe(410);
  });

  it('교체 헤더 형식이 틀리면 400', async () => {
    expect((await upload(makeApp(), { headers: { 'X-Replace-Id': '../x', 'X-Replace-Token': 't' } })).res.status).toBe(400);
    expect((await upload(makeApp(), { headers: { 'X-Replace-Id': newShareId(7) } })).res.status).toBe(400);
  });
});

describe('공통', () => {
  it('보안 헤더 — 성공·실패 모두', async () => {
    const app = makeApp();
    for (const res of [(await upload(app)).res, await get(app, '7-short'), await app.fetch(new Request(`${ORIGIN}/nope`), IP)]) {
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('지원하지 않는 메서드는 405, /healthz는 200', async () => {
    const app = makeApp();
    expect((await app.fetch(new Request(`${ORIGIN}/api/shares`), IP)).status).toBe(405);
    expect((await app.fetch(new Request(`${ORIGIN}/healthz`), IP)).status).toBe(200);
  });

  it('로그에 토큰이 없다', async () => {
    const app = makeApp();
    const a = await upload(app);
    await del(app, a.id, a.token);
    await upload(app, { headers: { 'X-Replace-Id': a.id, 'X-Replace-Token': 'REPLACE-SECRET' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(a.token);
    expect(logs.join('\n')).not.toContain('REPLACE-SECRET');
  });

  it('저장소 오류는 500 INTERNAL이고 원인 메시지를 응답에 싣지 않는다', async () => {
    const app = makeApp();
    store.put = async () => { throw new Error('EACCES /data/secret/path'); };
    const res = (await upload(app)).res;
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('/data/secret');
  });
});
