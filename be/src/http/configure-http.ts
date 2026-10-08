import * as path from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { accessControl } from '../access/access-control.middleware';
import type { AccessPolicy } from '../access/access-policy';

export interface HttpOptions {
  policy: AccessPolicy;
  /** 배포 이미지의 SPA 산출물(dist/public). 없으면 null — dev와 테스트. */
  publicDir: string | null;
}

/**
 * main.ts의 HTTP 구성 전부. 접근 제어 e2e가 같은 함수로 앱을 만든다 — 테스트하는 구성이 곧 운영 구성이다.
 *
 * **순서가 계약이다** (spec 2026-10-08 §3.3): 접근 제어 → JSON 파서 → prefix → SPA → Swagger. useBodyParser도
 * 내부에서 app.use를 부르고 Nest 기본 파서(urlencoded 포함)는 init()에서 붙으므로, 접근 제어가 먼저여야
 * 거부된 요청의 본문을 읽지 않는다. SPA·Swagger도 그 뒤라 DNS rebinding의 Host 검사를 받는다.
 */
export function configureHttp(app: NestExpressApplication, { policy, publicDir }: HttpOptions): void {
  app.use(accessControl(policy));
  // 회의 메모(meeting_note) 상한이 100,000자 — UTF-8로 한글은 글자당 3바이트라
  // 약 300KB. Express 기본 100kb 제한으로는 스펙의 상한 자체에 도달할 수 없다.
  app.useBodyParser('json', { limit: '1mb' });
  // 모든 API는 /api 아래. SPA 라우트(/meetings/:id)와 API(GET /meetings/:id)가 같은
  // 경로라 한 origin에서 같이 서빙하려면 한쪽에 prefix가 있어야 한다. Swagger는 /docs 그대로.
  app.setGlobalPrefix('api');

  // publicDir이 있으면(배포 이미지 — deploy/api.Dockerfile이 Vite 산출물을 넣는다) SPA도 같이 서빙한다.
  // init 전에 미들웨어로 거는 이유: init이 붙이는 Nest 404 핸들러 뒤에 오면 절대 실행되지 않는다.
  if (publicDir !== null) {
    app.useStaticAssets(publicDir);
    // /api·/docs 밖의 GET은 전부 index.html — 클라이언트 라우터가 받는다.
    const spa = /^\/(?!api(\/|$)|docs(\/|$)|docs-json$).*/;
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && spa.test(req.path)) res.sendFile(path.join(publicDir, 'index.html'));
      else next();
    });
  }

  const config = new DocumentBuilder()
    .setTitle('Damwha API')
    .setDescription('회의 녹음 인제스트/검색 백엔드 (NestJS). 발화(utterance)가 1급 객체.')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
