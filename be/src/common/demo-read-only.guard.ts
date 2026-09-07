import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * 공개 데모의 읽기 전용 가드 (설계 §3.6). DEMO_READ_ONLY=true 일 때 GET/HEAD/OPTIONS 외
 * 요청을 403으로 거절한다. 예외는 POST /search 하나 — 검색은 읽기인데 본문이 커서 POST다.
 *
 * SPA 인터셉터가 같은 요청을 앞에서 끊지만 그건 UX 장치다. API는 공개 URL이라
 * `curl -X DELETE /api/meetings/:id` 한 줄로 시드가 지워지므로 이 가드가 본체다.
 *
 * process.env를 요청 시점에 직접 읽는다 — loadEnv()는 DATABASE_URL을 요구해 유닛 테스트에서
 * 못 쓰고, 이 플래그 하나에 스키마 전체를 파싱할 이유도 없다.
 */
@Injectable()
export class DemoReadOnlyGuard implements CanActivate {
  private static readonly SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  private static readonly READ_POSTS = /^(\/api)?\/search\/?$/;

  canActivate(context: ExecutionContext): boolean {
    if (process.env.DEMO_READ_ONLY !== 'true') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (DemoReadOnlyGuard.SAFE_METHODS.has(req.method)) return true;
    if (req.method === 'POST' && DemoReadOnlyGuard.READ_POSTS.test(req.path)) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: 'DEMO_READ_ONLY',
      message: '데모 사이트라 결과 확인만 할 수 있어요.',
    });
  }
}
