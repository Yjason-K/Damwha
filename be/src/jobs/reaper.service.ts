import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from './jobs.repository';
import { isAppWorkerId } from './worker-identity';
import { loadEnv } from '../config/env';

@Injectable()
export class ReaperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReaperService.name);
  constructor(private readonly db: DatabaseService, private readonly jobs: JobsRepository) {}

  /**
   * 앞 실행이 남긴 job 회수 — 기동 시 1회. 크론 `reap()`과 역할이 갈린다:
   * 이쪽은 "앞 실행이 남긴 것", 저쪽은 "이번 실행 중에 죽은 것"이다.
   *
   * 실패해도 기동을 막지 않는다. 회수는 복구 가속이지 기동 조건이 아니며,
   * 실패하면 30분 reaper가 같은 일을 한다.
   */
  async onApplicationBootstrap(): Promise<void> {
    const workerId = loadEnv().WORKER_ID;
    // 값이 있어도 **앱이 띄운 신분일 때만** 돈다. 회수 SQL도 `desktop-` 행만 고르지만,
    // 경계를 한 군데서만 정해야 나중에 접두사가 바뀔 때 두 곳이 갈라지지 않는다.
    if (workerId === undefined || !isAppWorkerId(workerId)) return;
    try {
      const res = await this.jobs.reclaimOrphaned(this.db.pool, workerId);
      if (res.requeued || res.failedLive || res.failedSpent) {
        this.logger.warn(
          `reclaim: requeued=${res.requeued} failedLive=${res.failedLive} failedSpent=${res.failedSpent}`,
        );
      }
    } catch (e) {
      this.logger.error(`reclaim failed, leaving it to the stale reaper: ${String(e)}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reap() {
    const res = await this.jobs.reapStale(this.db.pool, loadEnv().REAPER_STALE_MINUTES);
    if (res.requeued || res.failed) {
      this.logger.warn(`reaper: requeued=${res.requeued} failed=${res.failed}`);
    }
  }
}
