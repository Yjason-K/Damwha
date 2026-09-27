import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { JobsModule } from './jobs/jobs.module';
import { MeetingsModule } from './meetings/meetings.module';
import { SpeakersModule } from './speakers/speakers.module';
import { SearchModule } from './search/search.module';
import { SettingsModule } from './settings/settings.module';
import { SystemModule } from './system/system.module';
import { ModelsModule } from './models/models.module';
import { LensesModule } from './lenses/lenses.module';
import { SummaryModule } from './summary/summary.module';
import { SavedUtterancesModule } from './saved-utterances/saved-utterances.module';
import { NotesModule } from './notes/notes.module';
import { LiveModule } from './live/live.module';
import { HealthController } from './health/health.controller';
import { HttpLoggingInterceptor } from './common/http-logging.interceptor';
import { DemoReadOnlyGuard } from './common/demo-read-only.guard';
import { DiskFullFilter } from './storage/disk-full.filter';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    JobsModule,
    MeetingsModule,
    SpeakersModule,
    SearchModule,
    SettingsModule,
    SystemModule,
    ModelsModule,
    LensesModule,
    SummaryModule,
    SavedUtterancesModule,
    NotesModule,
    LiveModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    // 공개 데모 읽기 전용(설계 §3.6). DEMO_READ_ONLY 미설정이면 no-op.
    { provide: APP_GUARD, useClass: DemoReadOnlyGuard },
    // 업로드 중 ENOSPC를 507로 바꾼다(Electron Phase 6a 스펙 §8.2). 이 앱의 유일한
    // 전역 필터라서 BaseExceptionFilter는 useFactory로 HttpAdapterHost를 직접 주입해야
    // 한다 — useClass면 생성자 인자가 비어 super.catch()가 런타임에 죽는다. host를
    // 통째로 넘기는 이유(host.httpAdapter 값을 미리 꺼내지 않는 이유)는
    // disk-full.filter.ts 머리 주석 참고 — e2e 테스트의 TestingModule.compile()에서는
    // 이 시점에 httpAdapter가 아직 없다.
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (host: HttpAdapterHost) => new DiskFullFilter(host),
    },
  ],
})
export class AppModule {}
