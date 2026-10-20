import { describe, expect, it } from 'vitest';
import { DamwhaClient } from '../src/client';
import { ApiRequestError } from '../src/errors';

function stub(res: Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return res.clone();
  }) as unknown as typeof fetch;
  return { calls, client: new DamwhaClient('http://h/api', fetchImpl) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DamwhaClient', () => {
  it('non-2xx throws ApiRequestError with message and code', async () => {
    const { client } = stub(json({ statusCode: 400, message: 'bad cursor', error: 'Bad Request', code: 'BAD_CURSOR' }, 400));
    const err = await client.getLens('x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 400, message: 'bad cursor', code: 'BAD_CURSOR' });
  });

  it('joins array messages and survives non-json bodies', async () => {
    const a = await stub(json({ message: ['a', 'b'] }, 422)).client.getLens('x').catch((e) => e);
    expect(a.message).toBe('a, b');
    const b = await stub(new Response('boom', { status: 502 })).client.getLens('x').catch((e) => e);
    expect(b).toMatchObject({ status: 502 });
  });

  it('listLenses encodes due_from/due_to as date_from/date_to and drops undefined', async () => {
    const { client, calls } = stub(json({ items: [], next_cursor: null, total: 0 }));
    await client.listLenses({ kind: 'todo', due_from: '2026-01-01', due_to: '2026-01-31', limit: 20, folder_id: undefined });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/api/lenses');
    expect(u.searchParams.get('date_from')).toBe('2026-01-01');
    expect(u.searchParams.get('date_to')).toBe('2026-01-31');
    expect(u.searchParams.get('kind')).toBe('todo');
    expect(u.searchParams.get('limit')).toBe('20');
    expect(u.searchParams.has('folder_id')).toBe(false);
    expect(u.searchParams.has('due_from')).toBe(false);
  });

  it('search posts json, completeLens posts, getTranscript encodes paging', async () => {
    const { client, calls } = stub(json({}));
    await client.search({ q: 'hi', limit: 5 });
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ q: 'hi', limit: 5 });
    await client.completeLens('l 1');
    expect(calls[1].url).toBe('http://h/api/lenses/l%201/complete');
    expect(calls[1].init?.method).toBe('POST');
    await client.getTranscript('m1', { offset: 10, limit: 50 });
    expect(calls[2].url).toBe('http://h/api/meetings/m1/transcript?offset=10&limit=50');
  });

  it('upload sends the FormData untouched (no content-type header)', async () => {
    const { client, calls } = stub(json({ id: 'm1' }));
    const form = new FormData();
    await client.upload(form);
    expect(calls[0].url).toBe('http://h/api/meetings');
    expect(calls[0].init?.body).toBe(form);
    expect(new Headers(calls[0].init?.headers).has('content-type')).toBe(false);
  });
});
