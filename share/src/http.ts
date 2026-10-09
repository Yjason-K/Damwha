/**
 * 뷰어 HTML은 같은 origin의 스크립트·스타일·API만 쓴다. 키가 페이지 URL(#)에 있으므로 바깥으로 나가는 경로
 * (외부 스크립트, referrer, 프레이밍)를 모두 닫는다 (spec §2.4·§2.5).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Content-Security-Policy', CSP);
  return out;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
