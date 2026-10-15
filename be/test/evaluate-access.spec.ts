import type { IncomingHttpHeaders } from 'node:http';
import { buildAccessPolicy } from '../src/access/access-policy';
import { evaluateAccess, hostnameOf, isGatedPath } from '../src/access/evaluate-access';

const POLICY = buildAccessPolicy('http://localhost:5173', 'damwha-demo.example');
const decide = (method: string, path: string, headers: IncomingHttpHeaders) =>
  evaluateAccess({ method, path, headers }, POLICY);
const allowed = (d: ReturnType<typeof decide>) => d.allow;
const code = (d: ReturnType<typeof decide>) => (d.allow ? null : d.code);

describe('hostnameOf', () => {
  it.each([
    ['127.0.0.1:3000', '127.0.0.1'],
    ['LOCALHOST:41234', 'localhost'],
    ['[::1]:3000', '[::1]'],
    ['damwha-demo.example', 'damwha-demo.example'],
    ['attacker@127.0.0.1', null],   // userinfo — URL 파서처럼 127.0.0.1로 읽으면 안 된다
    ['127.0.0.1:3000:1', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (h, want) => {
    expect(hostnameOf(h as string | undefined)).toBe(want);
  });
});

describe('isGatedPath', () => {
  it.each([
    ['GET', '/api/meetings', true],
    ['GET', '/API/meetings', true],
    ['GET', '/Api', true],
    ['GET', '/%61pi/meetings', true],   // 디코드해서 본다
    ['GET', '/apix', false],
    ['GET', '/', false],
    ['GET', '/docs', false],
    ['HEAD', '/meetings/m1', false],
    ['POST', '/anything', true],          // /api 밖이라도 GET·HEAD가 아니면 검사한다
    ['OPTIONS', '/', true],
    ['GET', '/%E0%A4%A', true],           // 디코드 실패 → 검사 쪽으로
  ])('%s %s → %s', (m, p, want) => {
    expect(isGatedPath(m, p)).toBe(want);
  });
});

describe('evaluateAccess — Host', () => {
  it.each([
    ['127.0.0.1:3000'], ['127.0.0.1:51234'], ['localhost:3000'], ['[::1]:3000'], ['localhost'],
    ['damwha-demo.example'], ['DAMWHA-DEMO.EXAMPLE'],
  ])('allows %s', (host) => {
    expect(allowed(decide('GET', '/api/health', { host }))).toBe(true);
  });

  it.each([['attacker.example:3000'], ['127.0.0.2:3000'], ['evil.localhost:3000'], ['']])('denies %s', (host) => {
    expect(code(decide('GET', '/api/health', { host }))).toBe('HOST_NOT_ALLOWED');
  });

  it('denies a request with no Host', () => {
    expect(code(decide('GET', '/api/health', {}))).toBe('HOST_NOT_ALLOWED');
  });

  it('checks Host outside /api too', () => {
    expect(code(decide('GET', '/', { host: 'attacker.example' }))).toBe('HOST_NOT_ALLOWED');
  });
});

describe('evaluateAccess — Origin', () => {
  const H = { host: '127.0.0.1:3000' };

  it('same origin passes without CORS', () => {
    expect(decide('POST', '/api/folders', { ...H, origin: 'http://127.0.0.1:3000' })).toEqual({ allow: true, corsOrigin: null });
  });

  it('same origin on a fallback port passes', () => {
    expect(allowed(decide('POST', '/api/folders', { host: '127.0.0.1:51234', origin: 'http://127.0.0.1:51234' }))).toBe(true);
  });

  it('IPv6 loopback same origin passes', () => {
    expect(allowed(decide('POST', '/api/folders', { host: '[::1]:3000', origin: 'http://[::1]:3000' }))).toBe(true);
  });

  it('allow-listed origin passes and gets CORS', () => {
    expect(decide('GET', '/api/meetings', { ...H, origin: 'http://localhost:5173' }))
      .toEqual({ allow: true, corsOrigin: 'http://localhost:5173' });
  });

  it('demo: https origin behind a tunnel that speaks http to us', () => {
    expect(allowed(decide('POST', '/api/search', {
      host: 'damwha-demo.example', origin: 'https://damwha-demo.example',
    }))).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://127.0.0.1:4000',          // 다른 포트
    'http://localhost:3000',          // 이름만 다른 같은 서버 — Host와 다르다
    'http://localhost:5173/',         // 끝 슬래시 — 목록과 정확히 같지 않다
    'null',
    'not a url',
  ])('denies Origin %s', (origin) => {
    expect(code(decide('POST', '/api/folders', { ...H, origin }))).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('message names the env to fix', () => {
    const d = decide('GET', '/api/meetings', { ...H, origin: 'http://localhost:5174' });
    expect(d.allow ? '' : d.message).toMatch(/ALLOWED_ORIGINS/);
  });
});

describe('evaluateAccess — no Origin', () => {
  const H = { host: '127.0.0.1:3000' };
  it.each(['cross-site', 'same-site'])('denies Sec-Fetch-Site: %s', (site) => {
    expect(code(decide('GET', '/api/meetings/m1/audio', { ...H, 'sec-fetch-site': site }))).toBe('ORIGIN_NOT_ALLOWED');
  });
  it.each(['same-origin', 'none'])('allows Sec-Fetch-Site: %s', (site) => {
    expect(allowed(decide('GET', '/api/meetings', { ...H, 'sec-fetch-site': site }))).toBe(true);
  });
  it('allows a header-less client (curl, desktop health probe, Node fetch)', () => {
    expect(decide('GET', '/api/health', { ...H, 'sec-fetch-mode': 'cors' })).toEqual({ allow: true, corsOrigin: null });
  });
  it('cross-site navigation outside /api passes (product site → demo /)', () => {
    expect(allowed(decide('GET', '/', { host: 'damwha-demo.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }))).toBe(true);
  });
});
