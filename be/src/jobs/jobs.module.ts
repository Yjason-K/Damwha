import { Global, Module } from '@nestjs/common';
import { JobsRepository } from './jobs.repository';
import { ReaperService } from './reaper.service';

@Global()
@Module({ providers: [JobsRepository, ReaperService], exports: [JobsRepository] })
export class JobsModule {}
