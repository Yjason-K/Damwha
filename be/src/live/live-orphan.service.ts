import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { JobRow, Queryable } from '../jobs/jobs.types';
import { LiveAudioService } from '../storage/live-audio.service';
import { LiveRepository } from './live.repository';
import { LiveService } from './live.service';
import { MeetingRow, MeetingsRepository } from '../meetings/meetings.repository';

/** 청크 주기가 1초이므로 90번 연속 실패는 재시도로 회복될 상황이 아니고, 실수로 탭을
 *  닫았다 되돌아오기엔 짧다 (설계 §4.7). */
export const ORPHAN_SECONDS = 90;

/**
 * 버려진 producer를 봉인한다.
 *
 * 기존 reaper로는 이것을 볼 수 없다. reapStale의 CTE는 job.locked_at staleness만 보는데
 * tail 대기 중인 워커는 heartbeat를 계속 뛴다 — 워커 생존은 브라우저 생존의 증거가 아니다.
 *
 * 후보 조회는 **힌트**다 (설계 §5). 조회와 잠금 사이에 브라우저가 정상 append를 커밋할 수
 * 있으므로, 잠근 뒤 DB 시계로 생존 조건을 다시 검사한다.
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

  /** pg bigint는 문자열로 온다. 안전 정수 범위 밖이면 경계 산술이 조용히 어긋난다
   *  (설계 §3.2). 던지면 이 후보만 건너뛰고 로그가 남는다 — 어긋난 경계로 봉인하느니
   *  아무것도 바꾸지 않는다. */
  private bigint(v: string | null, field: string): number {
    const n = Number(v);
    if (v === null || !Number.isSafeInteger(n)) {
      throw new Error(`${field} is out of range: ${String(v)}`);
    }
    return n;
  }

  /**
   * 오디오가 한 바이트도 없는 세션을 닫는다. 회의를 'recording'에서 빼내는 것이 요점이다 —
   * 안 빼면 meeting_single_recording_idx가 다음 녹음을 전부 막는다.
   *
   * job은 이미 failed일 수 있다(reaper가 먼저 내렸다). 그 경우 error를 덮지 않는다:
   * "워커를 잃었다"가 이 job에 실제로 일어난 일이고, "오디오가 없다"는 회의 쪽 사실이다.
   */
  private async closeEmpty(c: Queryable, job: JobRow, meetingId: string): Promise<boolean> {
    await this.meetings.markFailed(c, meetingId, {
      code: 'producer_never_started',
      message: 'the browser never sent any audio',
    });
    if (job.status !== 'failed') {
      await this.jobs.fail(c, job.id, {
        code: 'producer_never_started', kind: 'PERMANENT', stage: 'capture',
        message: 'no audio received',
      });
    }
    return true;
  }

  /**
   * 확정 경계로 봉인할 수 없는 세션을 I/O 실패로 끝낸다 (설계 §3.4 "파일이 확정 경계보다
   * 짧으면 봉인·finalize하지 않고 I/O 실패로 끝낸다").
   *
   * 봉인도 finalize도 하지 않는다 — 봉인 길이의 유일한 근거인 확정 경계가 파일에 실재하지
   * 않는데 봉인하면 정본이 조용히 잘린다. 그렇다고 그냥 두면 회의가 'recording'에 영원히
   * 갇혀 다음 녹음까지 막으므로, 실패로 닫는 것이 이 스캐너의 몫이다. closeEmpty와 같은
   * 이유로 이미 failed인 job의 error는 덮지 않는다.
   */
  private async closeIoFailure(
    c: Queryable, job: JobRow, meetingId: string, detail: string,
  ): Promise<boolean> {
    // 회의에는 사용자가 읽을 문장을, job에는 원인을. markDiskFailure와 같은 분담이다.
    const err = { code: 'io_error', message: 'could not seal the live audio at its committed boundary' };
    await this.meetings.markFailed(c, meetingId, err);
    if (job.status !== 'failed') {
      await this.jobs.fail(c, job.id, {
        ...err, kind: 'PERMANENT', stage: 'capture', message: detail,
      });
    }
    return true;
  }

  /**
   * 이미 봉인된 세션 (설계 §5 ④). producer 시각은 보지 않는다 — 봉인됐다는 것은 입력이
   * 끝났다는 뜻이라 생존 여부가 더는 질문이 아니다. 남은 질문은 "누가 마무리하는가"뿐이고,
   * 그 답은 job.status다: running이면 워커가 아직 들고 있으므로 기다린다.
   */
  private async recoverSealed(c: Queryable, job: JobRow, meeting: MeetingRow): Promise<boolean> {
    // 후보 질의가 이미 걸렀지만, 그 사이 재claim됐을 수 있다.
    if (job.status === 'running') return false;
    const bytes = this.bigint(job.sealed_bytes, 'sealed_bytes');
    // 0바이트 봉인은 스위퍼가 낸 것만이 아니다 — 사용자가 시작 직후 종료를 누르면
    // stop이 running job을 0에서 봉인하고 워커에게 맡긴다. 그 워커가 죽으면 여기
    // 온다. 넘길 녹음이 없으므로 finalize가 아니라 닫아야 한다. 그냥 두면 회의가
    // 영원히 recording이고 부분 유일 인덱스가 다음 녹음을 전부 막는다.
    if (bytes === 0) return await this.closeEmpty(c, job, meeting.id);
    return await this.liveService.finalizeByApi(c, job, meeting, bytes);
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
          // ① 잠그는 사이 사용자가 stop을 눌렀거나 cancel이 세션을 닫았을 수 있다.
          if (!job || !meeting || meeting.status !== 'recording'
              || meeting.current_job_id !== job.id) return false;

          // ④ 이미 봉인이면 producer 시각을 보지 않는다.
          if (job.sealed_bytes !== null) return await this.recoverSealed(c, job, meeting);

          // ② 미봉인이면 잠금을 얻은 지금의 DB 시계로 생존 조건을 다시 본다. 후보 조회와
          // 잠금 사이에 브라우저가 정상 append를 커밋했다면 이 세션은 살아 있다.
          // ③ 아직 신선하면 파일을 건드리지 않고 끝낸다.
          if (!(await this.live.isProducerExpired(c, job.id, seconds))) return false;

          // 오래됐다. 봉인 길이는 **확정 경계**다 — 파일 길이가 아니다 (설계 §3.4).
          // 크래시가 남긴 미확정 꼬리를 정본으로 인정하지 않으려면 먼저 잘라내야 한다.
          if (job.committed_bytes === null) {
            // 024 이전에 만들어져 지금도 살아 있는 세션. 확정 경계가 없으니 봉인할 길이도
            // 없고, 파일 길이로 역산하지 않는다 (설계 §3.2).
            return await this.closeIoFailure(
              c, job, meeting.id, 'this live session predates the committed byte boundary');
          }
          const bytes = this.bigint(job.committed_bytes, 'committed_bytes');
          try {
            await this.liveAudio.recover(meeting.audio_key, bytes);
          } catch (e) {
            // 파일이 확정 경계보다 짧거나 아예 없다. 디스크 오류이지 DB 오류가 아니므로
            // 이 트랜잭션은 멀쩡하다 — 같은 TX에서 실패로 닫는다.
            return await this.closeIoFailure(c, job, meeting.id, String(e));
          }
          await this.live.seal(c, job.id, bytes);
          // 넘길 녹음이 없다. 삭제하지 않는다 — 자동 스캐너가 사용자 데이터를 지우지
          // 않는다. 사용자가 직접 stop을 눌러 0바이트인 경우만 지운다 (설계 §4.7).
          if (bytes === 0) return await this.closeEmpty(c, job, meeting.id);
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
