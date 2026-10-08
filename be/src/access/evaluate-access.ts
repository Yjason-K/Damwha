import type { IncomingHttpHeaders } from 'node:http';
import { LOOPBACK_HOSTS, type AccessPolicy } from './access-policy';

/**
 * 요청 하나를 허용할지 정하는 순수 함수 (spec 2026-10-08-local-api-access-control §3.1).
 *
 * ① Host(모든 경로) — DNS rebinding. ② 브라우저 출처(/api 아래와 GET·HEAD가 아닌 요청) — 읽기·CSRF.
 * 판정 근거는 브라우저가 강제하는 헤더뿐이다. Origin·Sec-Fetch-Site가 없는 요청(curl, desktop 헬스 프로브,
 * Node fetch)은 브라우저가 아니므로 통과한다 — 같은 Mac의 로컬 프로세스는 위협 모델 밖이다(spec §2 5번).
 * Sec-Fetch-Mode는 보지 않는다: Node fetch(undici)가 `sec-fetch-mode: cors`를 붙인다(실측).
 */
export interface AccessRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export type AccessDenyCode = 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED';

export type AccessDecision =
  | { allow: true; corsOrigin: string | null }
  | { allow: false; code: AccessDenyCode; message: string };

// URL 파서를 쓰지 않는다 — `attacker@127.0.0.1`을 127.0.0.1로 읽는다.
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

export function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined) return null;
  const m = HOST_HEADER.exec(hostHeader.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * express 라우터는 대소문자를 구분하지 않는다 — `/API/health`도 같은 핸들러로 간다(실측 200).
 * 그래서 소문자·디코드 기준으로 본다. 디코드에 실패하면 검사 쪽으로 기운다.
 * /api 밖의 GET·HEAD(SPA, 정적 파일, /docs)는 공개 코드라 검사하지 않는다 — 제품 사이트가 데모 `/`로
 * cross-site 링크를 건다. /api 밖이라도 GET·HEAD가 아니면 검사한다(처리할 라우트가 없으니 잃을 것이 없다).
 */
export function isGatedPath(method: string, path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  if (/^\/api(\/|$)/i.test(decoded)) return true;
  return method !== 'GET' && method !== 'HEAD';
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** scheme은 비교하지 않는다 — 데모는 터널 바깥이 https, 우리에게 닿는 요청은 http다. Host는 ①을 통과한 값이다. */
function isSameOrigin(origin: string, host: string): boolean {
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

const deny = (code: AccessDenyCode, message: string): AccessDecision => ({ allow: false, code, message });

export function evaluateAccess(req: AccessRequest, policy: AccessPolicy): AccessDecision {
  const host = single(req.headers.host);
  const hostname = hostnameOf(host);
  if (hostname === null || !(LOOPBACK_HOSTS.has(hostname) || policy.allowedHosts.has(hostname))) {
    return deny('HOST_NOT_ALLOWED', `Host ${JSON.stringify(host ?? null)} is not allowed. Add its name to ALLOWED_HOSTS.`);
  }
  if (!isGatedPath(req.method, req.path)) return { allow: true, corsOrigin: null };

  const origin = single(req.headers.origin);
  if (origin !== undefined) {
    if (policy.allowedOrigins.has(origin)) return { allow: true, corsOrigin: origin };
    if (isSameOrigin(origin, host as string)) return { allow: true, corsOrigin: null };
    return deny(
      'ORIGIN_NOT_ALLOWED',
      `Origin ${JSON.stringify(origin)} may not call this API. If it is your own dev server, add it to ALLOWED_ORIGINS.`,
    );
  }
  const site = single(req.headers['sec-fetch-site']);
  if (site === 'cross-site' || site === 'same-site') {
    return deny('ORIGIN_NOT_ALLOWED', `Sec-Fetch-Site: ${site} request without an allowed Origin.`);
  }
  return { allow: true, corsOrigin: null };
}
