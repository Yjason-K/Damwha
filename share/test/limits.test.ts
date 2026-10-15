import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig, type ShareConfig } from '../src/config.js';
import { DailyBudget, WindowLimiter } from '../src/limits.js';
import { DiskStore } from '../src/store.js';
import { newDeleteToken, newShareId } from '@damwha/share-format';

let dir: string;
let store: DiskStore;
let clock: Date;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-limits-'));
  store = new DiskStore(dir);
  await store.init();
  clock = new Date('2026-10-09T03:00:00.000Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const makeApp = (over: Partial<ShareConfig> = {}) =>
  createApp({ store, config: { ...readConfig({}), dataDir: dir, ...over }, now: () => clock, viewerDir: null });
type App = ReturnType<typeof makeApp>;
/** be처럼 id·토큰을 만들어 올린다. 응답에 토큰이 없으므로 같이 돌려준다. */
async function post(app: App, origin = 'https://damwha-share.example', ip = '203.0.113.9', size = 100) {
  const id = newShareId(7);
  const token = newDeleteToken();
  const res = await app.fetch(
    new Request(`${origin}/api/shares`, {
      method: 'POST',
      headers: { 'X-Share-Days': '7', 'X-Share-Id': id, 'X-Delete-Token': token },
      body: new Uint8Array(size).fill(1),
    }),
    { ip },
  );
  return Object.assign(res, { shareId: id, token });
}

describe('업로드 차단 스위치', () => {
  it('uploadsEnabled=false면 업로드만 503, 조회·삭제는 그대로', async () => {
    const on = makeApp();
    const up = await post(on);
    const b = { id: up.shareId, delete_token: up.token };
    const off = makeApp({ uploadsEnabled: false });
    const res = await post(off);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UPLOADS_DISABLED' });
    expect((await off.fetch(new Request(`https://x/api/shares/${b.id}`), { ip: 'a' })).status).toBe(200);
    expect((await off.fetch(new Request(`https://x/api/shares/${b.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b.delete_token}` } }), { ip: 'a' })).status).toBe(204);
  });

  it('readConfig — UPLOADS_ENABLED=false일 때만 꺼진다', () => {
    expect(readConfig({}).uploadsEnabled).toBe(true);
    expect(readConfig({ UPLOADS_ENABLED: 'false' }).uploadsEnabled).toBe(false);
  });
});

describe('IP별 요청 제한', () => {
  it('업로드는 IP마다 따로 센다', async () => {
    const app = makeApp({ limits: { upload: 2, read: 100, delete: 100 } });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(429);
    expect((await post(app, undefined, '198.51.100.1')).status).toBe(201);
  });

  it('조회를 다 써도 삭제(지금 중지)는 막히지 않는다', async () => {
    const app = makeApp({ limits: { upload: 100, read: 1, delete: 100 } });
    const up = await post(app);
    const b = { id: up.shareId, delete_token: up.token };
    const ip = { ip: '203.0.113.9' };
    await app.fetch(new Request(`https://x/api/shares/${b.id}`), ip);
    expect((await app.fetch(new Request(`https://x/api/shares/${b.id}`), ip)).status).toBe(429);
    const del = await app.fetch(new Request(`https://x/api/shares/${b.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b.delete_token}` } }), ip);
    expect(del.status).toBe(204);
  });

  it('창이 지나면 다시 허용한다', () => {
    const l = new WindowLimiter(1, 60_000);
    expect(l.allow('k', 0)).toBe(true);
    expect(l.allow('k', 1000)).toBe(false);
    expect(l.allow('k', 60_000)).toBe(true);
  });
});

describe('서비스 전체 일일 상한', () => {
  it('객체 수 상한 — 동시에 몰려도 정확히 상한까지만', async () => {
    const app = makeApp({ dailyMaxUploads: 3, limits: { upload: 100, read: 100, delete: 100 } });
    const res = await Promise.all(Array.from({ length: 6 }, () => post(app)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 201, 201, 503, 503, 503]);
    // 거절된 요청은 파일도 남기지 않는다 — 상한 검사가 저장보다 앞선다
    expect(readdirSync(join(dir, 'shares')).filter((f) => f.endsWith('.json'))).toHaveLength(3);
  });

  it('바이트 상한', async () => {
    const app = makeApp({ dailyMaxBytes: 150 });
    expect((await post(app)).status).toBe(201);
    const res = await post(app);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'DAILY_CAP' });
  });

  it('날짜가 바뀌면 새로 센다', async () => {
    const app = makeApp({ dailyMaxUploads: 1 });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(503);
    clock = new Date('2026-10-10T00:00:01.000Z');
    expect((await post(app)).status).toBe(201);
  });

  it('저장에 실패한 업로드는 상한을 쓰지 않는다', async () => {
    const app = makeApp({ dailyMaxUploads: 1 });
    const put = store.put.bind(store);
    store.put = async () => { throw new Error('disk'); };
    expect((await post(app)).status).toBe(500);
    store.put = put;
    expect((await post(app)).status).toBe(201);
  });

  it('DailyBudget — 확인과 차감이 한 번에, 취소는 예약한 날짜에서만', () => {
    const b = new DailyBudget(2, 1000);
    const day1 = new Date('2026-10-09T23:59:59Z');
    const t1 = b.reserve(10, day1);
    expect(t1).not.toBeNull();
    expect(b.reserve(10, day1)).not.toBeNull();
    expect(b.reserve(10, day1)).toBeNull();
    b.release(t1!);
    expect(b.reserve(10, day1)).not.toBeNull();
  });

  it('자정 전에 예약한 업로드가 자정 뒤에 실패해도 새 날의 카운터를 줄이지 않는다', () => {
    const b = new DailyBudget(1, 1000);
    const late = b.reserve(10, new Date('2026-10-09T23:59:59Z'));
    const next = new Date('2026-10-10T00:00:01Z');
    expect(b.reserve(10, next)).not.toBeNull(); // 새 날 첫 업로드
    b.release(late!); // 전날 예약의 취소
    expect(b.reserve(10, next)).toBeNull(); // 새 날은 여전히 상한에 닿아 있다
  });
});

describe('개발용 만료 단축', () => {
  const expiresAfter = async (app: App, origin: string) => {
    const { expires_at } = (await (await post(app, origin)).json()) as { expires_at: string };
    return Date.parse(expires_at) - clock.getTime();
  };

  it('localhost·127.0.0.1에서는 devExpirySeconds를 따른다', async () => {
    const app = makeApp({ devExpirySeconds: 60 });
    expect(await expiresAfter(app, 'http://localhost:8787')).toBe(60_000);
    expect(await expiresAfter(app, 'http://127.0.0.1:8787')).toBe(60_000);
  });

  it('공개 도메인 Host에서는 무시한다', async () => {
    expect(await expiresAfter(makeApp({ devExpirySeconds: 60 }), 'https://damwha-share.0kimjae.dev')).toBe(7 * 86_400_000);
  });

  it('readConfig — production이면 DEV_EXPIRY_SECONDS를 읽지 않는다, 숫자가 아니거나 0 이하도 무시', () => {
    expect(readConfig({ DEV_EXPIRY_SECONDS: '60' }).devExpirySeconds).toBe(60);
    expect(readConfig({ DEV_EXPIRY_SECONDS: '60', NODE_ENV: 'production' }).devExpirySeconds).toBeNull();
    for (const v of ['', 'abc', '0', '-5']) expect(readConfig({ DEV_EXPIRY_SECONDS: v }).devExpirySeconds).toBeNull();
  });
});
