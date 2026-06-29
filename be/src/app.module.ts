import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { JobsModule } from './jobs/jobs.module';
import { MeetingsModule } from './meetings/meetings.module';
import { SpeakersModule } from './speakers/speakers.module';
import { SearchModule } from './search/search.module';
import { HealthController } from './health/health.controller';
import { HttpLoggingInterceptor } from './common/http-logging.interceptor';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    JobsModule,
    MeetingsModule,
    SpeakersModule,
    SearchModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor }],
})
export class AppModule {}
