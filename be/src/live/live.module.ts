import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import * as express from 'express';
import { LiveController } from './live.controller';
import { LiveOrphanService } from './live-orphan.service';
import { LiveRepository } from './live.repository';
import { LiveService, CHUNK_BYTES } from './live.service';
import { MeetingsModule } from '../meetings/meetings.module';
import { SettingsModule } from '../settings/settings.module';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [MeetingsModule, SettingsModule, SystemModule],
  controllers: [LiveController],
  providers: [LiveRepository, LiveService, LiveOrphanService],
  exports: [LiveOrphanService],
})
export class LiveModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // octet-stream 본문을 Buffer로 받는다. main.ts의 useBodyParser는 e2e 테스트 앱에
    // 걸리지 않으므로 여기에 둔다. 상한은 청크 하나 + 여유.
    consumer
      .apply(express.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES + 1024 }))
      .forRoutes(
        { path: 'meetings/:id/live/audio', method: RequestMethod.POST },
        { path: 'meetings/:id/live/stop', method: RequestMethod.POST },
      );
  }
}
