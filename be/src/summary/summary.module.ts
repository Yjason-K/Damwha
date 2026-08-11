import { Module } from '@nestjs/common';
import { SummaryRepository } from './summary.repository';
import { SummaryService } from './summary.service';

@Module({
  providers: [SummaryRepository, SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
