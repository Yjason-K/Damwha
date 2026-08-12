import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SummaryRepository } from './summary.repository';
import { SummaryService } from './summary.service';

@Module({
  // DatabaseModule/JobsModule은 @Global()이지만 SettingsModule은 아니다 — 명시 import 필요.
  imports: [SettingsModule],
  providers: [SummaryRepository, SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
