import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../src/app.module';
import { buildAccessPolicy } from '../src/access/access-policy';
import { configureHttp } from '../src/http/configure-http';
import { startTestDb, StartedTestDb } from './db';

/**
 * 상태를 바꾸는 GET 금지 (spec 2026-10-09 §2.7, 선행 결과 규칙 1). 쓰기 보호는 GET이 아닌 요청의 Origin 검사에
 * 기댄다 — no-cors GET은 Origin 없이 와서 통과한다. GET 라우트가 새로 생기면 이 테스트가 실패한다: 그 GET이
 * 아무것도 바꾸지 않는지 리뷰한 뒤 목록에 더한다.
 */
const EXPECTED_GET_ROUTES: string[] = [
  '/api/folders',
  '/api/health',
  '/api/lenses',
  '/api/lenses/extraction-status',
  '/api/meetings',
  '/api/meetings/:id',
  '/api/meetings/:id/audio',
  '/api/meetings/:id/lenses',
  '/api/meetings/:id/live',
  '/api/meetings/:id/note',
  '/api/meetings/:id/share',
  '/api/meetings/:id/status',
  '/api/models',
  '/api/saved-utterances',
  '/api/saved-utterances/ids',
  '/api/settings/processing',
  '/api/shares',
  '/api/speakers',
  '/api/speakers/:id',
  '/api/system/capabilities',
  '/api/tags',
];

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

describe('GET 라우트 목록', () => {
  let db: StartedTestDb;
  let app: NestExpressApplication;
  beforeAll(async () => {
    db = await startTestDb();
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication<NestExpressApplication>();
    configureHttp(app, { policy: buildAccessPolicy('', ''), publicDir: null });
    await app.init();
  });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('리뷰된 목록과 같다', () => {
    const stack: Layer[] = app.getHttpAdapter().getInstance()._router.stack;
    const gets = stack
      .filter((l) => l.route?.methods.get)
      .map((l) => l.route!.path)
      .filter((p) => p.startsWith('/api/'))
      .sort();
    expect(gets).toEqual(EXPECTED_GET_ROUTES);
  });
});
