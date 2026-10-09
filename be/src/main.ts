import 'dotenv/config';
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { buildAccessPolicy } from './access/access-policy';
import { loadEnv } from './config/env';
import { configureHttp } from './http/configure-http';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const publicDir = path.join(__dirname, 'public');
  configureHttp(app, {
    policy: buildAccessPolicy(env.ALLOWED_ORIGINS, env.ALLOWED_HOSTS),
    publicDir: fs.existsSync(publicDir) ? publicDir : null,
  });
  await app.listen(env.PORT, env.HOST);
  Logger.log(`Damwha API listening on ${env.HOST}:${env.PORT} (docs at /docs)`, 'Bootstrap');
}
bootstrap().catch((e: unknown) => {
  // DatabaseService.onModuleInit의 DB 프로브 실패 등 — 스택 대신 원인 한 줄로 끝낸다
  Logger.error(`startup failed: ${e instanceof Error ? e.message : String(e)}`, 'Bootstrap');
  process.exit(1);
});
