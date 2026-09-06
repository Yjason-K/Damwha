import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { LiveAudioService } from '../storage/live-audio.service';
import { LiveRepository } from './live.repository';
import { LiveService } from './live.service';
import { MeetingsRepository } from '../meetings/meetings.repository';

/** 청크 주기가 1초이므로 90번 연속 실패는 재시도로 회복될 상황이 아니고, 실수로 탭을
 *  닫았다 되돌아오기엔 짧다 (설계 §4.7). */
export const ORPHAN_SECONDS = 90;

/**
 * 버려진 producer를 봉인한다.
 *
 * 기존 reaper로는 이것을 볼 수 없다. reapStale의 CTE는 job.locked_at staleness만 보는데
 * tail 대기 중인 워커는 heartbeat를 계속 뛴다 — 워커 생존은 브라우저 생존의 증거가 아니다.
 * 그리고 봉인이 duration_ms를 알아야 해서 파일을 stat해야 하므로 SQL로는 못 한다.
 */
@Injectable()
export class LiveOrphanService {
  private readonly log = new Logger(LiveOrphanService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly live: LiveRepository,
    private readonly liveService: LiveService,
    private readonly liveAudio: LiveAudioService,
    private readonly meetings: MeetingsRepository,
    private readonly jobs: JobsRepository,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepScheduled() {
    await this.sweep();
  }

  async sweep(seconds = ORPHAN_SECONDS): Promise<number> {
    let candidates;
    try {
      candidates = await this.live.findOrphanCandidates(this.db.pool, seconds);
    } catch (e) {
      this.log.warn(`orphan sweep failed to fetch candidates: ${String(e)}`);
      return 0;
    }
    let sealed = 0;
    for (const { job_id, meeting_id } of candidates) {
      try {
        const done = await this.db.withTransaction(async (c) => {
          const job = await this.live.lockJobById(c, job_id);
          const meeting = await this.meetings.lockById(c, meeting_id);
          // 잠그는 사이 사용자가 stop을 눌렀을 수 있다.
          if (!job || !meeting || meeting.status !== 'recording'
              || meeting.current_job_id !== job.id) return false;

          if (job.sealed_bytes !== null) {
            // 이미 봉인됐는데 회의가 아직 recording이다 — 봉인할 때 워커에게 맡겼는데
            // 그 워커가 사라졌다. running이면 아직 그가 마무리할 수 있으므로 건드리지
            // 않는다 (candidate 질의가 이미 걸렀지만, 그 사이 재claim됐을 수 있다).
            if (job.status === 'running') return false;
            const bytes = Number(job.sealed_bytes);
            if (bytes === 0) return false; // 0바이트는 봉인 시점에 이미 failed로 닫혔다
            await this.liveService.finalizeByApi(c, job, meeting, bytes);
            return true;
          }

          const pcm = await this.liveAudio.pcmSize(meeting.audio_key);
          const bytes = Math.max(pcm, 0);
          await this.live.seal(c, job.id, bytes);
          if (bytes === 0) {
            // 넘길 녹음이 없다. 삭제하지 않는다 — 자동 스캐너가 사용자 데이터를 지우지
            // 않는다. 사용자가 직접 stop을 눌러 0바이트인 경우만 지운다 (설계 §4.7).
            await this.meetings.markFailed(c, meeting.id, {
              code: 'producer_never_started',
              message: 'the browser never sent any audio',
            });
            await this.jobs.fail(c, job.id, {
              code: 'producer_never_started', kind: 'PERMANENT', stage: 'capture',
              message: 'no audio received',
            });
            return true;
          }
          await this.live.setCaptureError(c, meeting.id, {
            code: 'producer_abandoned',
            message: 'the browser stopped sending audio',
            sealed_bytes: bytes,
          });
          // running인 동안만 워커가 stop_requested_at을 보고 스스로 finalize한다. 그 외
          // (queued·failed)는 이 job을 끝낼 워커가 없으므로 API가 맡는다 — failed는 reaper가
          // 워커를 잃었다고 판정한 job이다.
          if (job.status !== 'running') {
            await this.liveService.finalizeByApi(c, job, meeting, bytes);
          }
          return true;
        });
        if (done) sealed += 1;
      } catch (e) {
        this.log.warn(`orphan sweep failed for ${meeting_id}: ${String(e)}`);
      }
    }
    if (sealed > 0) this.log.log(`sealed ${sealed} abandoned live session(s)`);
    return sealed;
  }
}
