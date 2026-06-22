import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { JobsModule } from './jobs/jobs.module';
import { MeetingsModule } from './meetings/meetings.module';
import { SpeakersModule } from './speakers/speakers.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    JobsModule,
    MeetingsModule,
    SpeakersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
