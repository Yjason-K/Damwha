import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { serveViewer } from '../src/static.js';
import { DiskStore } from '../src/store.js';

const VIEWER = fileURLToPath(new URL('../dist/viewer', import.meta.url));
let dir: string;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-viewer-'));
  const store = new DiskStore(dir);
  await store.init();
  app = createApp({ store, config: { ...readConfig({}), dataDir: dir }, now: () => new Date(), viewerDir: VIEWER });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const get = (path: string) => app.fetch(new Request(`https://damwha-share.example${path}`), { ip: 'a' });

it('/s/:id는 뷰어 HTML이고 inline 스크립트가 없으며 보안 헤더가 붙는다', async () => {
  const res = await get('/s/7-AAAAAAAAAAAAAAAAAAAAAA');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const html = await res.text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
});

it('번들 자산은 맞는 Content-Type과 보안 헤더로', async () => {
  const html = await (await get('/s/7-AAAAAAAAAAAAAAAAAAAAAA')).text();
  const src = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(src).toBeDefined();
  const res = await get(src!);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

it('assets 밖의 파일·인코딩된 경로·모르는 확장자는 404', async () => {
  for (const p of ['/index.html', '/assets/%2e%2e%2fpackage.json', '/assets/x.exe', '/s/a/b']) {
    expect((await get(p)).status).toBe(404);
  }
});

// Request는 URL의 `..`를 정규화하므로 HTTP로는 날것의 탈출 경로를 보낼 수 없다 — serveViewer에 직접 넘긴다.
it('serveViewer — 정규화되지 않은 탈출 경로를 받지 않는다', async () => {
  for (const p of ['/assets/../index.html', '/assets/../../package.json', '/assets/sub/x.js', '/assets/.hidden.js', '/s/../x']) {
    expect(await serveViewer(p, VIEWER)).toBeNull();
  }
});

// 확장자 검사가 없어도 막혀야 한다 — 실제로 존재하는 번들 파일로 되돌아오는 경로는 정규식만이 거른다.
it('serveViewer — 존재하는 번들로 되돌아오는 `..` 경로도 받지 않는다', async () => {
  const html = await (await get('/s/7-AAAAAAAAAAAAAAAAAAAAAA')).text();
  const src = html.match(/src="\/assets\/([^"]+\.js)"/)![1];
  expect(await serveViewer(`/assets/${src}`, VIEWER)).not.toBeNull();
  expect(await serveViewer(`/assets/../assets/${src}`, VIEWER)).toBeNull();
});
