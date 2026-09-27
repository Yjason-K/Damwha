import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { LensesController } from './lenses.controller';
import { LensesService } from './lenses.service';
import { LensesRepository } from './lenses.repository';
import { LensExtractionRepository } from './lens-extraction.repository';
import { LensExtractionService } from './lens-extraction.service';

@Module({
  // SettingsModule은 @Global()이 아니다 — 명시 import 필요.
  imports: [SettingsModule],
  controllers: [LensesController],
  providers: [LensesService, LensesRepository, LensExtractionRepository, LensExtractionService],
  exports: [LensesRepository, LensesService, LensExtractionService],
})
export class LensesModule {}
