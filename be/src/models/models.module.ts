import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { JobsModule } from '../jobs/jobs.module';
import { SettingsModule } from '../settings/settings.module';
import { SystemModule } from '../system/system.module';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

@Module({
  imports: [DatabaseModule, JobsModule, SettingsModule, SystemModule],
  controllers: [ModelsController],
  providers: [ModelsService],
})
export class ModelsModule {}
