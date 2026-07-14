import { Module } from '@nestjs/common';
import { LensesController } from './lenses.controller';
import { LensesService } from './lenses.service';
import { LensesRepository } from './lenses.repository';
import { LensExtractionRepository } from './lens-extraction.repository';
import { LensExtractionService } from './lens-extraction.service';

@Module({
  controllers: [LensesController],
  providers: [LensesService, LensesRepository, LensExtractionRepository, LensExtractionService],
  exports: [LensesRepository, LensesService, LensExtractionService],
})
export class LensesModule {}
