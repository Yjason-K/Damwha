import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from './jobs.repository';
import { loadEnv } from '../config/env';

@Injectable()
export class ReaperService {
  private readonly logger = new Logger(ReaperService.name);
  constructor(private readonly db: DatabaseService, private readonly jobs: JobsRepository) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reap() {
    const res = await this.jobs.reapStale(this.db.pool, loadEnv().REAPER_STALE_MINUTES);
    if (res.requeued || res.failed) {
      this.logger.warn(`reaper: requeued=${res.requeued} failed=${res.failed}`);
    }
  }
}
