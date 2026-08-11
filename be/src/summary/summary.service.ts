import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { buildSummarizeMeetingPayload } from '../contracts/job-payload.schema';
import { loadEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { SummaryRepository } from './summary.repository';
import { SummaryRow } from './summary.types';

export interface SummaryRequestResult {
  status: string;
  job_id: string | null;
  processing_version: number;
}

@Injectable()
export class SummaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRepository,
    private readonly summaries: SummaryRepository,
  ) {}

  get(meetingId: string): Promise<SummaryRow | null> {
    return this.summaries.findCurrent(meetingId);
  }

  async request(meetingId: string): Promise<SummaryRequestResult> {
    const model = loadEnv().SUMMARY_LLM_MODEL;
    return this.db.withTransaction(async (exec) => {
      const meeting = await this.summaries.lockMeeting(exec, meetingId);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (meeting.status !== 'done') {
        throw new ConflictException('summary generation allowed only when status is done');
      }

      const active = await this.summaries.findActive(exec, meeting.id, meeting.processing_version);
      if (active) {
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
}
