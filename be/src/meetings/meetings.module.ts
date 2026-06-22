import { Module } from '@nestjs/common';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { MeetingsRepository } from './meetings.repository';

@Module({
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingsRepository],
  exports: [MeetingsRepository, MeetingsService],
})
export class MeetingsModule {}
