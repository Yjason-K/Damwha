const LOCAL = new Set(['localhost', '127.0.0.1']);

/**
 * 공유 서버 주소 (spec selfhost-v2 §2.7 "밖으로 나가는 HTTP"). https만, 개발용 http://localhost·127.0.0.1만 예외.
 * 경로·쿼리·자격 증명이 붙은 값은 받지 않는다 — 링크(`<origin>/s/<id>#<key>`)와 API 경로를 이 origin에서 만든다.
 */
export function parseShareApiUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`SHARE_API_URL ${JSON.stringify(raw)} is not a URL`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) {
    throw new Error('SHARE_API_URL must be https (http is allowed only for localhost and 127.0.0.1)');
  }
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
    throw new Error('SHARE_API_URL must be a bare origin — no path, query or credentials');
  }
  return u;
}
