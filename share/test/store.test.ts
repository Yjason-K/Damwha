import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiskStore } from '../src/store.js';

/** readdir 순서는 파일시스템마다 다르다 — 순서를 바꿔 `.json`이 `.bin`보다 먼저 오는 경우를 결정적으로 만든다. */
const order = vi.hoisted(() => ({ reverse: false }));
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (path: string) => {
      const names = await actual.readdir(path);
      return order.reverse ? [...names].sort().reverse() : names;
    }) as unknown as typeof actual.readdir,
  };
});

let dir: string;
let store: DiskStore;
const ID = '7-AAAAAAAAAAAAAAAAAAAAAA';
const meta = (expires_at: string) => ({ expires_at, token_hash: 'h', size: 3, created_at: '2026-10-09T00:00:00.000Z' });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-store-'));
  store = new DiskStore(dir);
  await store.init();
});
afterEach(() => {
  order.reverse = false;
  rmSync(dir, { recursive: true, force: true });
});

it('put → get → delete', async () => {
  await store.put(ID, new Uint8Array([1, 2, 3]), meta('2026-10-16T00:00:00.000Z'));
  expect(await store.get(ID)).toEqual({ body: new Uint8Array([1, 2, 3]), meta: meta('2026-10-16T00:00:00.000Z') });
  expect(await store.delete(ID)).toBe(true);
  expect(await store.get(ID)).toBeNull();
  expect(await store.delete(ID)).toBe(false);
});

it('메타가 없으면 봉투가 있어도 없는 것이다 (쓰다 만 상태)', async () => {
  writeFileSync(join(dir, 'shares', `${ID}.bin`), new Uint8Array([9]));
  expect(await store.get(ID)).toBeNull();
});

it('경로를 벗어나는 id는 받지 않는다', async () => {
  await expect(store.put('../x', new Uint8Array([1]), meta('2026-10-16T00:00:00.000Z'))).rejects.toThrow(/invalid share id/);
  await expect(store.head('7-../../etc')).rejects.toThrow(/invalid share id/);
});

it('sweep — 만료된 쌍을 지우고 아직 유효한 것은 남긴다', async () => {
  const live = '7-BBBBBBBBBBBBBBBBBBBBBB';
  await store.put(ID, new Uint8Array([1]), meta('2026-10-09T00:00:00.000Z'));
  await store.put(live, new Uint8Array([1]), meta('2026-10-20T00:00:00.000Z'));
  expect(await store.sweep(new Date('2026-10-10T00:00:00.000Z'))).toBe(1);
  expect(existsSync(join(dir, 'shares', `${ID}.bin`))).toBe(false);
  expect(await store.head(live)).not.toBeNull();
});

it('sweep — 메타 없는 봉투·임시 파일은 1시간이 지나야 지운다', async () => {
  const orphan = join(dir, 'shares', `${ID}.bin`);
  const tmp = join(dir, 'shares', `7-CCCCCCCCCCCCCCCCCCCCCC.json.tmp`);
  writeFileSync(orphan, new Uint8Array([1]));
  writeFileSync(tmp, '{}');
  const now = new Date();
  expect(await store.sweep(now)).toBe(0);
  const old = new Date(now.getTime() - 2 * 3_600_000);
  utimesSync(orphan, old, old);
  utimesSync(tmp, old, old);
  expect(await store.sweep(now)).toBe(2);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(tmp)).toBe(false);
});

it('sweep — 쌍의 한쪽이 이미 지워졌어도(readdir 순서와 무관하게) 던지지 않는다', async () => {
  await store.put(ID, new Uint8Array([1]), meta('2026-10-09T00:00:00.000Z'));
  order.reverse = true; // .json이 먼저 → 쌍을 지운 뒤 목록에 남은 .bin을 만난다
  expect(await store.sweep(new Date('2026-10-10T00:00:00.000Z'))).toBe(1);
  expect(existsSync(join(dir, 'shares', `${ID}.bin`))).toBe(false);
});

describe('해석할 수 없는 메타 (이슈 #106 DCS-3)', () => {
  const BROKEN = '7-AAAAAAAAAAAAAAAAAAAAAB';
  const writePair = (id: string, metaText: string) => {
    writeFileSync(join(dir, 'shares', `${id}.bin`), new Uint8Array([1]));
    writeFileSync(join(dir, 'shares', `${id}.json`), metaText);
  };
  const gone = (id: string) =>
    !existsSync(join(dir, 'shares', `${id}.json`)) && !existsSync(join(dir, 'shares', `${id}.bin`));

  it.each([
    ['빈 파일', ''],
    ['잘린 JSON', '{"expires_at":"2026-10'],
    ['객체가 아님', 'null'],
    ['만료 시각을 해석할 수 없음', JSON.stringify(meta('garbage'))],
    ['토큰 해시가 없음', JSON.stringify({ expires_at: '2026-10-20T00:00:00.000Z' })],
  ])('%s — head는 없는 것으로 보고 그 쌍을 지운다', async (_, text) => {
    writePair(BROKEN, text);
    expect(await store.head(BROKEN)).toBeNull();
    expect(gone(BROKEN)).toBe(true);
  });

  it.each([false, true])('sweep은 깨진 메타를 지우고 멈추지 않는다 — 뒤의 만료 항목도 지운다 (reverse=%s)', async (reverse) => {
    order.reverse = reverse;
    writePair(BROKEN, '');
    await store.put(ID, new Uint8Array([1]), meta('2026-10-09T00:00:00.000Z'));
    expect(await store.sweep(new Date('2026-10-10T00:00:00.000Z'))).toBe(2);
    expect(gone(BROKEN)).toBe(true);
    expect(gone(ID)).toBe(true);
  });

  it('sweep — 한 항목의 다른 오류도 나머지 청소를 막지 않고, 끝난 뒤 그 오류로 reject한다', async () => {
    order.reverse = true; // 오류 항목(…AB)이 만료 항목(…AA)보다 먼저 온다
    mkdirSync(join(dir, 'shares', `${BROKEN}.json`)); // readFile → EISDIR
    await store.put(ID, new Uint8Array([1]), meta('2026-10-09T00:00:00.000Z'));
    await expect(store.sweep(new Date('2026-10-10T00:00:00.000Z'))).rejects.toMatchObject({ code: 'EISDIR' });
    expect(gone(ID)).toBe(true);
  });
});
