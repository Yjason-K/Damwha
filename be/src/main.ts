import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // 개인용 셀프호스팅 전제 (제한 없는 기본형)

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
