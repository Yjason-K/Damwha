import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { buildExtractLensesPayload } from '../contracts/job-payload.schema';
import { loadEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { SettingsService } from '../settings/settings.service';
import { LensExtractionRepository, LensExtractionRunRow } from './lens-extraction.repository';

export interface LensExtractionRequest {
  run_id: string;
  job_id: string | null;
  status: string;
  processing_version: number;
}

@Injectable()
export class LensExtractionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRepository,
    private readonly extractions: LensExtractionRepository,
    private readonly settings: SettingsService,
  ) {}

  async request(meetingId: string): Promise<LensExtractionRequest> {
    const model = loadEnv().LENS_LLM_MODEL;
    // 설정 로드는 트랜잭션 전에 (summary.service.ts와 같은 순서).
    const outputLanguage = (await this.settings.getProcessingConfig()).summary_language;
    return this.db.withTransaction(async (exec) => {
      const meeting = await this.extractions.lockMeeting(exec, meetingId);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (meeting.status !== 'done') {
        throw new ConflictException('lens extraction allowed only when status is done');
      }

      const active = await this.extractions.findActiveRun(exec, meeting.id, meeting.processing_version);
      // 진행 중 추출이 다른 언어로 큐잉됐어도 그것을 돌려준다 — lens_extraction_run에 언어 열이
      // 없다. 끝난 뒤 다시 요청하면 새 언어로 만든다.
      if (active) return this.response(active);

      const run = await this.extractions.createQueuedRun(exec, {
        meetingId: meeting.id, processingVersion: meeting.processing_version, model,
      });
      const payload = buildExtractLensesPayload({
        meetingId: meeting.id,
        processingVersion: meeting.processing_version,
        extractionRunId: run.id,
        model,
        outputLanguage,
      });
      const job = await this.jobs.enqueue(exec, {
        type: 'extract_lenses', meetingId: meeting.id, payload,
      });
      const queued = await this.extractions.setJobId(exec, run.id, job.id);
      return this.response(queued);
    });
  }

  /**
   * 운영자 취소 (POST /meetings/:id/lenses/cancel). 화면 미노출 — 진행 중 run이
   * 없으면 409. 잡과 run을 함께 failed(cancelled)로 닫는다.
   *
   * 잠금은 job → meeting → run 순서다 — 워커(mark_lens_run_running 등)가 job을 먼저 잠그므로
   * meeting을 먼저 잠그면 교차 deadlock이 난다(이슈 #80). job id는 잠그지 않은 조회로 얻고,
   * 잠근 뒤 진행 중 run이 여전히 그 job인지 다시 확인한다.
   */
  async cancel(meetingId: string): Promise<{ job_id: string; status: 'failed' }> {
    return this.db.withTransaction(async (exec) => {
      const probe = await this.extractions.findActiveJobId(exec, meetingId);
      const job = probe ? await this.jobs.lockById(exec, probe) : null;
      const meeting = await this.extractions.lockMeeting(exec, meetingId);
      if (!meeting) throw new NotFoundException('meeting not found');
      const active = await this.extractions.findActiveRun(exec, meeting.id, meeting.processing_version);
      if (!active?.job_id || !job || active.job_id !== job.id
          || (job.status !== 'queued' && job.status !== 'running')) {
        throw new ConflictException('no lens extraction in progress to cancel');
      }

      const error = JobsRepository.cancelledError('extract_lenses');
      await this.jobs.cancel(exec, active.job_id, error);
      await this.extractions.markRunCancelled(exec, active.id, error);
      return { job_id: active.job_id, status: 'failed' };
    });
  }

  private response(run: LensExtractionRunRow): LensExtractionRequest {
    return {
      run_id: run.id,
      job_id: run.job_id,
      status: run.status,
      processing_version: run.processing_version,
    };
  }
}
