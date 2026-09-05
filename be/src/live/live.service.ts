import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { MeetingsRepository } from '../meetings/meetings.repository';
import { SettingsService } from '../settings/settings.service';
import { CapabilitiesService } from '../system/capabilities.service';
import { ProcessingOverride, ProcessingOverrideSchema, resolveProcessingConfig } from '../settings/resolve-processing';
import { SpeakerBounds, SpeakerBoundsSchema } from '../meetings/speaker-bounds';
import { buildLiveSessionPayload } from '../contracts/job-payload.schema';
import { nextId } from '../common/id';
import { LiveRepository } from './live.repository';

const RECORDING_INDEX = 'meeting_single_recording_idx';

function isSingleRecordingViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === '23505' && err?.constraint === RECORDING_INDEX;
}

@Injectable()
export class LiveService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly jobs: JobsRepository,
    private readonly meetings: MeetingsRepository,
    private readonly live: LiveRepository,
    private readonly settings: SettingsService,
    private readonly caps: CapabilitiesService,
  ) {}

  // JSON body라 multipart 문자열 파싱은 없다. 불리언은 불리언으로 받되, 업로드와의 대칭을
  // 위해 "true"/"false" 문자열도 받는다. 그 외는 400.
  private parseFlag(v: unknown, field: string): boolean {
    if (v === undefined || v === null || v === '' || v === false || v === 'false') return false;
    if (v === true || v === 'true') return true;
    throw new BadRequestException(`${field} must be a boolean`);
  }

  private parseTitle(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new BadRequestException('title must be a string');
    const t = v.trim();
    return t === '' ? null : t;
  }

  private parseOverride(v: unknown): ProcessingOverride | undefined {
    if (v === undefined) return undefined;
    const r = ProcessingOverrideSchema.safeParse(v);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  private parseSpeakers(v: unknown): SpeakerBounds | undefined {
    if (v === undefined) return undefined;
    const r = SpeakerBoundsSchema.safeParse(v);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  async start(body: {
    title?: unknown; processing?: unknown; speakers?: unknown; defer_lens?: unknown; defer_summary?: unknown;
  }) {
    const title = this.parseTitle(body.title);
    const override = this.parseOverride(body.processing);
    const speakers = this.parseSpeakers(body.speakers);
    const followups = {
      lens: !this.parseFlag(body.defer_lens, 'defer_lens'),
      summary: !this.parseFlag(body.defer_summary, 'defer_summary'),
    };
    const global_ = await this.settings.getProcessingConfig();
    const processing = resolveProcessingConfig(global_, override, (await this.caps.get()).gpu_eligible);

    // 친절한 메시지를 위한 사전 조회. 보장은 아래 INSERT의 부분 유일 인덱스가 한다 (설계 §4).
    if (await this.live.findRecording(this.db.pool)) {
      throw new ConflictException('a recording is already in progress');
    }
    const meetingId = await nextId(this.db.pool, 'meeting');
    const audioKey = this.storage.meetingKey(meetingId, 'live.wav');
    try {
      return await this.db.withTransaction(async (c) => {
        await this.live.createRecording(c, { id: meetingId, audioKey, title });
        const payload = buildLiveSessionPayload({ meetingId, audioKey, processing, followups, speakers });
        // 재시도 없음 — 끊긴 녹음은 이어 붙일 수 없다 (설계 §2.6).
        const job = await this.jobs.enqueue(c, { type: 'live_session', meetingId, payload, maxAttempts: 1 });
        return this.meetings.setCurrentJob(c, meetingId, job.id);
      });
    } catch (e) {
      if (isSingleRecordingViolation(e)) throw new ConflictException('a recording is already in progress');
      throw e;
    }
  }

  async stop(id: string): Promise<{ meeting_id: string; job_id: string; outcome: 'stopping' | 'discarded' }> {
    const result = await this.db.withTransaction(async (c) => {
      const job = await this.live.lockSessionJob(c, id); // job 먼저 (설계 §4 잠금 순서)
      const meeting = await this.meetings.lockById(c, id);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (meeting.status !== 'recording' || !job) throw new ConflictException('meeting is not recording');
      if (job.status === 'running') {
        await this.live.requestStop(c, job.id);
        return { meeting_id: id, job_id: job.id, outcome: 'stopping' as const };
      }
      if (job.status === 'queued') {
        // 워커가 아직 마이크를 열지 않았다 — 녹음된 게 없으니 회의째 지운다 (job은 cascade).
        await this.meetings.deleteById(c, id);
        return { meeting_id: id, job_id: job.id, outcome: 'discarded' as const };
      }
      throw new ConflictException(`live session job is ${job.status}`);
    });
    if (result.outcome === 'discarded') await this.storage.deleteDir(this.storage.meetingDir(id));
    return result;
  }

  async getLive(id: string, after: string | undefined) {
    let afterSeq = -1;
    if (after !== undefined) {
      if (!/^-?\d+$/.test(after)) throw new BadRequestException('after must be an integer seq');
      afterSeq = Number(after);
    }
    const head = await this.live.findHead(this.db.pool, id);
    if (!head) throw new NotFoundException('meeting not found');
    const items = await this.live.findUtterances(this.db.pool, id, afterSeq);
    return { status: head.status, stage: head.stage, heartbeat_at: head.heartbeat_at, items };
  }
}
