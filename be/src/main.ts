import 'dotenv/config';
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors(); // 개인용 셀프호스팅 전제 (제한 없는 기본형)
  // 모든 API는 /api 아래. SPA 라우트(/meetings/:id)와 API(GET /meetings/:id)가 같은
  // 경로라 한 origin에서 같이 서빙하려면 한쪽에 prefix가 있어야 한다. Swagger는 /docs 그대로.
  app.setGlobalPrefix('api');

  // dist/public이 있으면(배포 이미지 — deploy/api.Dockerfile이 Vite 산출물을 넣는다)
  // SPA도 같이 서빙한다. 개발에선 폴더가 없어 아무 일도 하지 않는다. 둘 다 init 전에
  // 미들웨어로 거는 이유: init이 붙이는 Nest 404 핸들러 뒤에 오면 절대 실행되지 않는다.
  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
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
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(env.PORT);
  Logger.log(`Damwha API listening on :${env.PORT} (docs at /docs)`, 'Bootstrap');
}
bootstrap().catch((e: unknown) => {
  // DatabaseService.onModuleInit의 DB 프로브 실패 등 — 스택 대신 원인 한 줄로 끝낸다
  Logger.error(`startup failed: ${e instanceof Error ? e.message : String(e)}`, 'Bootstrap');
  process.exit(1);
});
