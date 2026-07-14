import { Module } from '@nestjs/common';
import { LensesController } from './lenses.controller';
import { LensesService } from './lenses.service';
import { LensesRepository } from './lenses.repository';

@Module({
  controllers: [LensesController],
  providers: [LensesService, LensesRepository],
  exports: [LensesRepository, LensesService],
})
export class LensesModule {}
