import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const VIEWER_PAGE = /^\/s\/[^/]+\/?$/;
// 파일 이름 한 단계만 — `..`·슬래시·인코딩된 문자는 이 정규식을 통과하지 못한다.
const ASSET = /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function file(path: string, type: string): Promise<Response | null> {
  try {
    return new Response(await readFile(path), { headers: { 'Content-Type': type } });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** `/s/<id>` → 뷰어 index.html, `/assets/<파일>` → 번들. 그 밖은 null(호출부가 404). id 검사는 뷰어가 한다. */
export async function serveViewer(pathname: string, dir: string): Promise<Response | null> {
  if (VIEWER_PAGE.test(pathname)) return file(join(dir, 'index.html'), 'text/html; charset=utf-8');
  if (!ASSET.test(pathname)) return null;
  const type = TYPES[extname(pathname)];
  return type ? file(join(dir, pathname), type) : null;
}
