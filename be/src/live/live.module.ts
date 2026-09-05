import { Module } from '@nestjs/common';
import { LiveController } from './live.controller';
import { LiveRepository } from './live.repository';
import { LiveService } from './live.service';
import { MeetingsModule } from '../meetings/meetings.module';
import { SettingsModule } from '../settings/settings.module';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [MeetingsModule, SettingsModule, SystemModule],
  controllers: [LiveController],
  providers: [LiveRepository, LiveService],
})
export class LiveModule {}
