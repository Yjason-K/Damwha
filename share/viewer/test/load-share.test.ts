// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encryptShare, generateShareKey, type SharePayloadV1 } from '@damwha/share-format';
import { loadShare } from '../src/load-share';

const ID = '7-AAAAAAAAAAAAAAAAAAAAAA';
const EXP = '2026-10-16T03:00:00.000Z';
const payload: SharePayloadV1 = {
  v: 1, created_at: 'a', ui_language: 'ko',
  meeting: { title: '회의', recorded_at: '2026-10-08T00:00:00.000Z', duration_ms: null }, speakers: [],
};
const respond = (status: number, body?: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) => async () =>
  new Response(body ?? null, { status, headers });

describe('loadShare', () => {
  it('id·키가 맞으면 복호화한 페이로드와 서버가 정한 만료 시각', async () => {
    const key = generateShareKey();
    const env = (await encryptShare(payload, key)) as Uint8Array<ArrayBuffer>;
    const calls: string[] = [];
    const r = await loadShare({ pathname: `/s/${ID}`, hash: `#${key}` }, async (url) => {
      calls.push(String(url));
      return new Response(env, { headers: { 'X-Share-Expires-At': EXP } });
    });
    expect(r).toEqual({ kind: 'ok', payload, expiresAt: EXP });
    expect(calls).toEqual([`/api/shares/${ID}`]); // 키는 요청 URL에 실리지 않는다
  });

  it('키가 없거나 id 형식이 틀리면 요청하지 않고 invalid', async () => {
    let called = false;
    const f = async () => ((called = true), new Response(null));
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '' }, f)).toEqual({ kind: 'invalid' });
    expect(await loadShare({ pathname: '/s/nope', hash: '#k' }, f)).toEqual({ kind: 'invalid' });
    expect(called).toBe(false);
  });

  it('410이면 gone', async () => {
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, respond(410))).toEqual({ kind: 'gone' });
  });

  it('다른 키로는 invalid — 페이로드를 내지 않는다', async () => {
    const env = (await encryptShare(payload, generateShareKey())) as Uint8Array<ArrayBuffer>;
    expect(await loadShare({ pathname: `/s/${ID}`, hash: `#${generateShareKey()}` }, respond(200, env, { 'X-Share-Expires-At': EXP }))).toEqual({ kind: 'invalid' });
  });

  it('네트워크 실패·5xx·429는 error', async () => {
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, async () => { throw new TypeError('offline'); })).toEqual({ kind: 'error' });
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, respond(503))).toEqual({ kind: 'error' });
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, respond(429))).toEqual({ kind: 'error' });
  });
});
