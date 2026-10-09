import { SHARE_MAX_ENVELOPE_BYTES, newDeleteToken, newShareId } from '@damwha/share-format';
import { parseShareApiUrl } from '../src/shares/share-api-url';
import { shareEnabled } from '../src/shares/share-enabled';
import { ShareClient, ShareServiceError, ShareTooLargeError, type UploadOptions } from '../src/shares/share-client';
import { startFakeShareServer, FakeShareServer } from './fake-share-server';

describe('parseShareApiUrl', () => {
  it.each(['https://share.example', 'https://share.example/', 'http://localhost:8787', 'http://127.0.0.1:8787'])('%s 허용', (u) => {
    expect(() => parseShareApiUrl(u)).not.toThrow();
  });
  it.each(['http://share.example', 'https://share.example/api', 'https://u:p@share.example', 'https://share.example/?a=1', 'ftp://x', 'nope', ''])(
    '%s 거절',
    (u) => { expect(() => parseShareApiUrl(u)).toThrow(/SHARE_API_URL/); },
  );
});

describe('shareEnabled', () => {
  it.each([
    ['127.0.0.1', 'false', true],
    ['::1', 'false', true],
    ['localhost', 'false', true],
    ['0.0.0.0', 'false', false],
    ['192.168.0.10', 'false', false],
    ['127.0.0.1', 'true', false],
  ])('HOST=%s DEMO_READ_ONLY=%s → %s', (HOST, DEMO_READ_ONLY, expected) => {
    expect(shareEnabled({ HOST, DEMO_READ_ONLY })).toBe(expected);
  });
});

describe('ShareClient', () => {
  let fake: FakeShareServer;
  let client: ShareClient;
  beforeEach(async () => { fake = await startFakeShareServer(); client = new ShareClient(fake.url, 300); });
  afterEach(async () => { await fake.close(); });
  const opts = (over: Partial<UploadOptions> = {}): UploadOptions => ({ id: newShareId(7), deleteToken: newDeleteToken(), days: 7, ...over });

  it('업로드 — be가 만든 id·토큰과 기간을 헤더로, 본문을 그대로 보낸다', async () => {
    const o = opts();
    const up = await client.upload(new Uint8Array([1, 2, 3]), o);
    expect(up.replaced).toBe(false);
    expect(Date.parse(up.expires_at)).toBeGreaterThan(Date.now());
    const h = fake.requests[0].headers;
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/api/shares' });
    expect([h['x-share-days'], h['x-share-id'], h['x-delete-token'], h['content-type']]).toEqual(['7', o.id, o.deleteToken, 'application/octet-stream']);
    expect([...fake.objects.get(o.id)!.body]).toEqual([1, 2, 3]);
  });

  it('같은 id·토큰으로 다시 올리면 성공(멱등 200)이다 — 응답 유실 뒤 재시도', async () => {
    const o = opts();
    const first = await client.upload(new Uint8Array([1]), o);
    expect(await client.upload(new Uint8Array([1]), o)).toEqual({ expires_at: first.expires_at, replaced: false });
  });

  it('교체 — 기존 id·토큰을 헤더로 싣고, 응답의 replaced를 돌려준다', async () => {
    const old = opts();
    await client.upload(new Uint8Array([1]), old);
    const fresh = await client.upload(new Uint8Array([2]), opts({ replace: { id: old.id, token: old.deleteToken } }));
    expect(fresh.replaced).toBe(true);
    expect(fake.requests[1].headers['x-replace-id']).toBe(old.id);
    expect(fake.requests[1].headers['x-replace-token']).toBe(old.deleteToken);
    expect(fake.objects.has(old.id)).toBe(false);
  });

  it('교체 토큰이 틀리면 rejected/403이고 "분명히 만들지 않음"', async () => {
    const old = opts();
    await client.upload(new Uint8Array([1]), old);
    await expect(client.upload(new Uint8Array([2]), opts({ replace: { id: old.id, token: 'wrong' } }))).rejects.toMatchObject({
      kind: 'rejected', status: 403, definitelyNotCreated: true,
    });
  });

  it('상한을 넘는 봉투는 보내지도 않는다', async () => {
    await expect(client.upload(new Uint8Array(SHARE_MAX_ENVELOPE_BYTES + 1), opts())).rejects.toBeInstanceOf(ShareTooLargeError);
    expect(fake.requests).toHaveLength(0);
  });

  it('철회 — 처음엔 deleted, 다시 하면 gone', async () => {
    const o = opts({ days: 1, id: newShareId(1) });
    await client.upload(new Uint8Array([1]), o);
    expect(await client.remove(o.id, o.deleteToken)).toBe('deleted');
    expect(await client.remove(o.id, o.deleteToken)).toBe('gone');
  });

  it('리다이렉트를 따라가지 않는다', async () => {
    fake.mode = 'redirect';
    await expect(client.upload(new Uint8Array([1]), opts())).rejects.toMatchObject({ kind: 'rejected', status: 302, definitelyNotCreated: false });
    expect(fake.requests).toHaveLength(1);
  });

  it('503은 rejected/503 — 만들었는지 모른다', async () => {
    fake.mode = 'busy503';
    await expect(client.upload(new Uint8Array([1]), opts())).rejects.toMatchObject({ kind: 'rejected', status: 503, definitelyNotCreated: false });
  });

  it('연결이 끊기면 unreachable', async () => {
    fake.mode = 'drop';
    await expect(client.upload(new Uint8Array([1]), opts())).rejects.toMatchObject({ kind: 'unreachable', definitelyNotCreated: false });
  });

  it('저장된 뒤 응답을 잃어도 unreachable — 호출부는 만들었을 수 있다고 본다', async () => {
    fake.mode = 'storeThenDrop';
    const o = opts();
    await expect(client.upload(new Uint8Array([1]), o)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(fake.objects.has(o.id)).toBe(true);
  });

  it('타임아웃이면 unreachable', async () => {
    fake.delayMs = 1000;
    await expect(client.upload(new Uint8Array([1]), opts())).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('201인데 replaced만 boolean이 아니면 rejected', async () => {
    fake.mode = 'garbage';
    await expect(client.upload(new Uint8Array([1]), opts())).rejects.toMatchObject({ kind: 'rejected', status: 201 });
  });

  it('201인데 expires_at만 날짜가 아니면 rejected', async () => {
    fake.mode = 'garbageDate';
    await expect(client.upload(new Uint8Array([1]), opts())).rejects.toMatchObject({ kind: 'rejected', status: 201 });
  });

  it('오류 메시지에 삭제 토큰이 없다', async () => {
    fake.mode = 'down500';
    const err = await client.remove(newShareId(7), 'SECRET-TOKEN-123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShareServiceError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain('SECRET-TOKEN-123');
  });

  it('링크는 <origin>/s/<id>#<key>', () => {
    expect(new ShareClient('https://share.example/').linkFor('7-x', 'KEY')).toBe('https://share.example/s/7-x#KEY');
  });
});
