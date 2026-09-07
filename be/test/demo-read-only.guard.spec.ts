import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { DemoReadOnlyGuard } from '../src/common/demo-read-only.guard';

function httpContext(method: string, path: string): ExecutionContext {
  const req = { method, path };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('DemoReadOnlyGuard', () => {
  const original = process.env.DEMO_READ_ONLY;
  afterEach(() => {
    if (original === undefined) delete process.env.DEMO_READ_ONLY;
    else process.env.DEMO_READ_ONLY = original;
  });

  it('is a no-op when DEMO_READ_ONLY is not set', () => {
    delete process.env.DEMO_READ_ONLY;
    const guard = new DemoReadOnlyGuard();
    expect(guard.canActivate(httpContext('DELETE', '/api/meetings/mtg_1'))).toBe(true);
  });

  describe('with DEMO_READ_ONLY=true', () => {
    beforeEach(() => { process.env.DEMO_READ_ONLY = 'true'; });
    const guard = () => new DemoReadOnlyGuard();

    it.each(['GET', 'HEAD', 'OPTIONS'])('allows %s', (method) => {
      expect(guard().canActivate(httpContext(method, '/api/meetings'))).toBe(true);
    });

    it.each([
      ['POST', '/api/meetings'],
      ['PATCH', '/api/meetings/mtg_1'],
      ['DELETE', '/api/meetings/mtg_1'],
      ['PUT', '/api/settings/processing'],
      ['POST', '/api/lenses/lens_1/complete'],
      ['POST', '/api/meetings/mtg_1/reprocess'],
    ])('rejects %s %s with 403 and a demo message', (method, path) => {
      expect(() => guard().canActivate(httpContext(method, path))).toThrow(ForbiddenException);
      try {
        guard().canActivate(httpContext(method, path));
      } catch (e) {
        const body = (e as ForbiddenException).getResponse() as { message: string; code: string };
        expect(body.code).toBe('DEMO_READ_ONLY');
        expect(body.message).toMatch(/데모/);
      }
    });

    it('allows POST /search because search is a read with a body', () => {
      expect(guard().canActivate(httpContext('POST', '/api/search'))).toBe(true);
      expect(guard().canActivate(httpContext('POST', '/search'))).toBe(true); // 테스트 앱은 prefix 없음
    });

    it('does not let /search prefix leak to other paths', () => {
      expect(() => guard().canActivate(httpContext('POST', '/api/search-index'))).toThrow(ForbiddenException);
    });
  });
});
