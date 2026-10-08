import type { RequestHandler } from 'express';
import type { AccessPolicy } from './access-policy';
import { evaluateAccess } from './evaluate-access';

const ALLOW_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

/**
 * 로컬 API 접근 제어 + CORS (spec 2026-10-08 §3.1~§3.2). `app.enableCors()`를 대신한다 — CORS 판정과 접근 판정이
 * 따로 놀면 어긋나므로 evaluateAccess 하나로 둘 다 정한다. configureHttp의 첫 미들웨어여야 한다.
 *
 * 프레임 헤더를 판정보다 먼저 건다: 같은 origin 요청은 ②를 통과하므로, 악성 페이지가 앱을 iframe에 넣고
 * 사용자를 속여 버튼을 누르게 하는 경로는 이 헤더만 막는다. 403에도 실린다.
 */
export function accessControl(policy: AccessPolicy): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');

    const decision = evaluateAccess({ method: req.method, path: req.path, headers: req.headers }, policy);
    if (!decision.allow) {
      res.status(403).json({ statusCode: 403, code: decision.code, message: decision.message });
      return;
    }
    if (decision.corsOrigin !== null) {
      res.setHeader('Access-Control-Allow-Origin', decision.corsOrigin);
      res.append('Vary', 'Origin');
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
        res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
        const requested = req.headers['access-control-request-headers'];
        if (requested !== undefined) res.setHeader('Access-Control-Allow-Headers', requested);
        res.setHeader('Access-Control-Max-Age', '600');
        res.append('Vary', 'Access-Control-Request-Headers');
        res.status(204).end();
        return;
      }
    }
    next();
  };
}
