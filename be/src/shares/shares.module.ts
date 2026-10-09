import { Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { ShareClient } from './share-client';
import { shareEnabled } from './share-enabled';
import { SHARE_ENABLED, ShareEnabledGuard } from './share-enabled.guard';
import { MeetingShareController, SharesController } from './shares.controller';
import { SharesRepository } from './shares.repository';
import { SharesService } from './shares.service';

@Module({
  controllers: [MeetingShareController, SharesController],
  providers: [
    SharesRepository,
    SharesService,
    ShareEnabledGuard,
    { provide: SHARE_ENABLED, useFactory: () => shareEnabled(loadEnv()) },
    { provide: ShareClient, useFactory: () => new ShareClient(loadEnv().SHARE_API_URL) },
  ],
  exports: [SharesRepository, SharesService, SHARE_ENABLED],
})
export class SharesModule {}
