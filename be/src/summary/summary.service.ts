import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { buildSummarizeMeetingPayload } from '../contracts/job-payload.schema';
import { SUMMARY_MODELS } from '../contracts/model-catalog';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { SettingsService } from '../settings/settings.service';
import { SummaryRepository } from './summary.repository';
import { SummaryRow } from './summary.types';

export interface SummaryRequestResult {
  status: string;
  job_id: string | null;
  processing_version: number;
}

// 요약 재생성 한정 오버라이드 — 저장하지 않는다 (spec §6).
export const SummaryGenerateBodySchema = z.object({
  summary_model: z.enum(SUMMARY_MODELS).optional(),
}).strict();

@Injectable()
export class SummaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRepository,
    private readonly summaries: SummaryRepository,
    private readonly settings: SettingsService,
  ) {}

  get(meetingId: string): Promise<SummaryRow | null> {
    return this.summaries.findCurrent(meetingId);
  }

  async request(meetingId: string, body?: unknown): Promise<SummaryRequestResult> {
    const parsed = SummaryGenerateBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    // 설정 로드(DB)는 트랜잭션 진입 전에 — spec §5의 순서 원칙.
    const model =
      parsed.data.summary_model ?? (await this.settings.getProcessingConfig()).summary_model;

    return this.db.withTransaction(async (exec) => {
      const meeting = await this.summaries.lockMeeting(exec, meetingId);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (meeting.status !== 'done') {
        throw new ConflictException('summary generation allowed only when status is done');
      }

      const active = await this.summaries.findActive(exec, meeting.id, meeting.processing_version);
      if (active) {
        if (active.model !== model) {
          // 큐에 든 job의 payload는 불변이라 모델을 갈아끼울 수 없다. 조용히
          // 무시하면 "고른 적 없는 모델의 결과"가 나온다 (spec §6).
          throw new ConflictException(
            `summary already in progress with model ${active.model}; ` +
            `wait for it to finish before requesting ${model}`,
          );
        }
        return {
          status: active.status,
          job_id: active.job_id,
          processing_version: meeting.processing_version,
        };
      }

      const payload = buildSummarizeMeetingPayload({
        meetingId: meeting.id,
        processingVersion: meeting.processing_version,
        model,
      });
      const job = await this.jobs.enqueue(exec, {
        type: 'summarize_meeting', meetingId: meeting.id, payload,
      });
      await this.summaries.upsertQueued(exec, {
        meetingId: meeting.id,
        processingVersion: meeting.processing_version,
        jobId: job.id,
        model,
      });
      return { status: 'queued', job_id: job.id, processing_version: meeting.processing_version };
    });
  }

  /**
   * 운영자 취소 (POST /meetings/:id/summary/cancel). 화면에는 노출하지 않는다 —
   * 메모리 부족 등으로 LLM 요약이 계속 실패할 때 직접 호출해 끊는 용도.
   * 현재 processing_version의 진행 중 요약이 없으면 409.
   */
  async cancel(meetingId: string): Promise<{ job_id: string; status: 'failed' }> {
    return this.db.withTransaction(async (exec) => {
      const meeting = await this.summaries.lockMeeting(exec, meetingId);
      if (!meeting) throw new NotFoundException('meeting not found');
      const active = await this.summaries.findActive(exec, meeting.id, meeting.processing_version);
      if (!active?.job_id) throw new ConflictException('no summary in progress to cancel');

      const error = JobsRepository.cancelledError('summarize_meeting');
      await this.jobs.cancel(exec, active.job_id, error);
      await this.summaries.markCancelled(exec, meeting.id, error);
      return { job_id: active.job_id, status: 'failed' };
    });
  }
}
