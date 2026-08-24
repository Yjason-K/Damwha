import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SystemModule } from '../system/system.module';
import { SettingsController } from './settings.controller';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

@Module({
  imports: [DatabaseModule, SystemModule],
  controllers: [SettingsController],
  providers: [SettingsRepository, SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
