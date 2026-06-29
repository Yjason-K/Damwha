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
bootstrap();
