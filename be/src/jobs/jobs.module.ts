import { Global, Module } from '@nestjs/common';
import { JobsRepository } from './jobs.repository';

@Global()
@Module({ providers: [JobsRepository], exports: [JobsRepository] })
export class JobsModule {}
