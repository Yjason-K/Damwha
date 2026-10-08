import { Logger } from '@nestjs/common';
import type { RequestHandler } from 'express';
import type { AccessPolicy } from './access-policy';
import { evaluateAccess, isGatedPath } from './evaluate-access';

const ALLOW_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';
/** 거부 로그가 기억하는 서로 다른 Origin/Host의 상한 — 악성 페이지가 임의 값으로 메모리를 키우지 못하게. */
const MAX_REMEMBERED = 100;

/**
 * 로컬 API 접근 제어 + CORS (spec 2026-10-08 §3.1~§3.2). `app.enableCors()`를 대신한다 — CORS 판정과 접근 판정이
 * 따로 놀면 어긋나므로 evaluateAccess 하나로 둘 다 정한다. configureHttp의 첫 미들웨어여야 한다.
 *
 * 프레임 헤더를 판정보다 먼저 건다: 같은 origin 요청은 ②를 통과하므로, 악성 페이지가 앱을 iframe에 넣고
 * 사용자를 속여 버튼을 누르게 하는 경로는 이 헤더만 막는다. 403에도 실린다.
 */
export function accessControl(policy: AccessPolicy): RequestHandler {
  const logger = new Logger('AccessControl');
  const seen = new Set<string>();
  /** 403에는 ACAO가 없어 브라우저 페이지는 본문(ALLOWED_ORIGINS 안내)을 못 읽는다 — 개발자가 볼 곳은 서버 로그뿐이다.
   *  값마다 처음 한 번만 남긴다. 상한이 차면 새 값은 남기지도 기억하지도 않는다. */
  const logFirst = (kind: string, value: string | string[] | undefined, message: string) => {
    const key = `${kind}:${String(value)}`;
    if (seen.has(key) || seen.size >= MAX_REMEMBERED) return;
    seen.add(key);
    logger.warn(message);
  };
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');

    // 캐시가 /api 응답을 Origin 사이에서 재사용하지 못하게: 403·Origin 없는 응답 포함, 게이트 경로 전부.
    if (policy.allowedOrigins.size > 0 && isGatedPath(req.method, req.path)) res.append('Vary', 'Origin');

    const decision = evaluateAccess({ method: req.method, path: req.path, headers: req.headers }, policy);
    if (!decision.allow) {
      logFirst(decision.code, decision.code === 'HOST_NOT_ALLOWED' ? req.headers.host : req.headers.origin, decision.message);
      res.status(403).json({ statusCode: 403, code: decision.code, message: decision.message });
      return;
    }
    if (decision.corsOrigin !== null) {
      res.setHeader('Access-Control-Allow-Origin', decision.corsOrigin);
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
