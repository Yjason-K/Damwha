import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

@Module({
  imports: [DatabaseModule],
  providers: [SettingsRepository, SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
