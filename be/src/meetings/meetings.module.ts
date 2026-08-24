import { Module } from '@nestjs/common';
import { MeetingsController } from './meetings.controller';
import { ClustersController } from './clusters.controller';
import { MeetingsService } from './meetings.service';
import { MeetingsRepository } from './meetings.repository';
import { SettingsModule } from '../settings/settings.module';
import { SystemModule } from '../system/system.module';
import { LensesModule } from '../lenses/lenses.module';
import { SummaryModule } from '../summary/summary.module';

@Module({
  imports: [SettingsModule, SystemModule, LensesModule, SummaryModule],
  controllers: [MeetingsController, ClustersController],
  providers: [MeetingsService, MeetingsRepository],
  exports: [MeetingsRepository, MeetingsService],
})
export class MeetingsModule {}
