import { decryptShare, SHARE_ID_RE, type SharePayloadV1 } from '@damwha/share-format';

export type LoadResult =
  | { kind: 'ok'; payload: SharePayloadV1; expiresAt: string | null }
  | { kind: 'invalid' }
  | { kind: 'gone' }
  | { kind: 'error' };

/**
 * 링크(`/s/<id>#<key>`)를 읽어 공유본을 받는다. 키는 `#` 뒤라 서버로 가지 않는다 — 요청 URL에는 id만 실린다.
 * 만료 시각은 페이로드가 아니라 서버 응답 헤더에서 온다(권위가 서버다, spec selfhost-v2 §2.4).
 */
export async function loadShare(
  loc: { pathname: string; hash: string },
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<LoadResult> {
  const id = loc.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
  const key = loc.hash.replace(/^#/, '');
  if (!id || !SHARE_ID_RE.test(id) || !key) return { kind: 'invalid' };
  let res: Response;
  try {
    res = await fetchFn(`/api/shares/${id}`, { cache: 'no-store' });
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 410) return { kind: 'gone' };
  if (res.status === 404) return { kind: 'invalid' };
  if (!res.ok) return { kind: 'error' };
  try {
    const payload = await decryptShare(new Uint8Array(await res.arrayBuffer()), key);
    return { kind: 'ok', payload, expiresAt: res.headers.get('X-Share-Expires-At') };
  } catch {
    return { kind: 'invalid' };
  }
}
