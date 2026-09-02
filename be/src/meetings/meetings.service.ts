import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { decodeOriginalName } from '../storage/upload-options';
import { JobsRepository } from '../jobs/jobs.repository';
import {
  buildProcessMeetingPayload, buildIndexMeetingPayload, Followups,
} from '../contracts/job-payload.schema';
import { MeetingsRepository, MeetingRow } from './meetings.repository';
import { SettingsService } from '../settings/settings.service';
import { ProcessingConfig } from '../settings/presets';
import {
  ProcessingOverride, ProcessingOverrideSchema, resolveProcessingConfig,
} from '../settings/resolve-processing';
import { CapabilitiesService } from '../system/capabilities.service';
import { SpeakerBounds, SpeakerBoundsSchema } from './speaker-bounds';
import { loadEnv } from '../config/env';
import { nextId } from '../common/id';
import { isIso8601 } from '../common/iso8601';
import { LensExtractionService } from '../lenses/lens-extraction.service';
import { SummaryService } from '../summary/summary.service';
import * as fs from 'fs';

const AUDIO_MIME = /^audio\//;
const SPEAKER_ID_RE = /^spk_[1-9][0-9]*$/;

async function unlinkQuietly(p?: string) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch { /* already gone */ }
}

@Injectable()
export class MeetingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly jobs: JobsRepository,
    private readonly meetings: MeetingsRepository,
    private readonly settings: SettingsService,
    private readonly lensExtraction: LensExtractionService,
    private readonly summary: SummaryService,
    private readonly caps: CapabilitiesService,
  ) {}

  // Validation scope (Plan 1): MIME + extension + size only. Deep audio-integrity
  // validation (ffmpeg probe) happens in the Plan 2 worker normalize stage.
  async upload(
    file: Express.Multer.File | undefined,
    body: {
      title?: string; recorded_at?: string; processing?: string; speakers?: string;
      defer_lens?: string; defer_summary?: string;
    },
  ) {
    if (!file) throw new BadRequestException('audio file required');
    if (!AUDIO_MIME.test(file.mimetype)) {
      await unlinkQuietly(file.path); // remove the temp file multer already wrote
      throw new BadRequestException('file must be audio/*');
    }
    // parse/검증/resolve를 saveFromTemp 전에 수행 (spec §5) — 실패 시 temp 파일 unlink로
    // 고아 파일 금지. storage 저장/DB INSERT는 설정이 유효할 때만.
    let processing: ProcessingConfig;
    let followups: Followups;
    let speakers: SpeakerBounds | undefined;
    let recordedAt: string | undefined;
    try {
      recordedAt = this.parseRecordedAt(body.recorded_at);
      const override = this.parseOverrideString(body.processing); // JSON.parse + zod, 오류는 BadRequest
      speakers = this.parseSpeakersString(body.speakers);
      const global_ = await this.settings.getProcessingConfig();
      processing = resolveProcessingConfig(global_, override, (await this.caps.get()).gpu_eligible);
      followups = {
        lens: !this.parseDeferFlag(body.defer_lens, 'defer_lens'),
        summary: !this.parseDeferFlag(body.defer_summary, 'defer_summary'),
      };
    } catch (e) {
      await unlinkQuietly(file.path); // 검증 실패 → 고아 파일 금지 (spec §5)
      throw e;
    }

    const meetingId = await nextId(this.db.pool, 'meeting');
    const originalName = decodeOriginalName(file.originalname);
    const audioKey = this.storage.meetingKey(meetingId, originalName);
    await this.storage.saveFromTemp(audioKey, file.path);

    return this.db.withTransaction(async (c) => {
      const meeting = await c.query(
        // DEFAULT는 컬럼을 생략했을 때만 걸린다. 값 바인딩을 유지하려면 COALESCE로
        // "미지정 = 등록 시각" 규칙을 SQL 한 곳에 둔다 (문장을 두 벌로 나누면
        // 파라미터 번호가 갈라진다).
        `INSERT INTO meeting(id, title, original_filename, audio_key, recorded_at, status)
         VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now()),'uploaded') RETURNING *`,
        [meetingId, body.title ?? null, originalName, audioKey, recordedAt ?? null],
      );
      const payload = buildProcessMeetingPayload({
        meetingId, audioKey, processingVersion: 0, reprocess: false, processing, followups, speakers,
      });
      const job = await this.jobs.enqueue(c, { type: 'process_meeting', meetingId, payload });
      const updated = await this.meetings.setCurrentJob(c, meetingId, job.id);
      return updated;
    });
  }

  // multipart 필드는 전부 문자열이라 zod boolean을 쓸 수 없다. 생략은 false(=미루지
  // 않음)로, 그 외 오타는 조용히 false로 흘리지 않고 BadRequest — 미룰 의도가 오타
  // 하나로 사라지면 사용자는 오래 걸리는 렌즈/요약을 그대로 맞게 된다.
  private parseDeferFlag(s: string | undefined, field: string): boolean {
    if (s === undefined || s === '') return false;
    if (s === 'true') return true;
    if (s === 'false') return false;
    throw new BadRequestException(`${field} must be "true" or "false"`);
  }

  // 생략과 빈 문자열은 둘 다 "미지정"이다 — INSERT의 COALESCE가 등록 시각으로
  // 채운다. multipart 필드는 비워도 ''로 도착하므로 정규화하지 않으면
  // ''::timestamptz가 캐스트 에러(500)를 낸다.
  private parseRecordedAt(s: string | undefined): string | undefined {
    if (s === undefined || s === '') return undefined;
    if (!isIso8601(s)) throw new BadRequestException('recorded_at must be an ISO-8601 datetime');
    return s;
  }

  private parseSpeakersString(s: string | undefined): SpeakerBounds | undefined {
    if (s === undefined || s === '') return undefined;
    let raw: unknown;
    try { raw = JSON.parse(s); } catch { throw new BadRequestException('speakers must be a valid JSON string'); }
    return this.parseSpeakers(raw);
  }

  private parseSpeakers(raw: unknown): SpeakerBounds | undefined {
    if (raw === undefined) return undefined;
    const r = SpeakerBoundsSchema.safeParse(raw);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  private parseOverrideString(s: string | undefined): ProcessingOverride | undefined {
    if (s === undefined) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(s); } catch { throw new BadRequestException('processing must be a valid JSON string'); }
    const r = ProcessingOverrideSchema.safeParse(raw);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  async setFavorite(id: string, value: boolean): Promise<MeetingRow> {
    const updated = await this.meetings.setFavorite(this.db.pool, id, value);
    if (!updated) throw new NotFoundException('meeting not found');
    return updated;
  }

  // Manual validation (no global ValidationPipe): title must be string|null,
  // recorded_at must be an ISO-8601 datetime. null is rejected — the column is
  // NOT NULL since migration 021 and every meeting keeps a reference time.
  async update(id: string, body: { title?: unknown; recorded_at?: unknown }): Promise<MeetingRow> {
    const patch: { title?: string | null; recorded_at?: string } = {};
    if ('title' in body) {
      if (body.title !== null && typeof body.title !== 'string') {
        throw new BadRequestException('title must be a string or null');
      }
      patch.title = body.title as string | null;
    }
    if ('recorded_at' in body) {
      if (typeof body.recorded_at !== 'string' || !isIso8601(body.recorded_at)) {
        throw new BadRequestException(
          'recorded_at must be an ISO-8601 datetime (null is not accepted — every meeting has a reference time)',
        );
      }
      patch.recorded_at = body.recorded_at;
    }
    const updated = await this.meetings.update(this.db.pool, id, patch);
    if (!updated) throw new NotFoundException('meeting not found');
    return updated;
  }

  // Cascade removes clusters/utterances/embeddings/jobs; then drop on-disk files.
  // An in-flight worker holding this meeting's job is tolerated: its ownership
  // guards discard when the job/meeting rows disappear (see db-schema notes).
  async remove(id: string): Promise<void> {
    const deleted = await this.db.withTransaction((c) => this.meetings.deleteById(c, id));
    if (!deleted) throw new NotFoundException('meeting not found');
    await this.storage.deleteDir(this.storage.meetingDir(id));
  }

  async list() { return this.meetings.list(this.db.pool); }

  async get(id: string) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    const utterances = await this.meetings.findUtterances(this.db.pool, id);
    const clusters = await this.meetings.findClusters(this.db.pool, id);
    const summary = await this.summary.get(id);
    return { ...meeting, utterances, clusters, summary };
  }

  async getStatus(id: string) {
    const status = await this.meetings.findStatus(this.db.pool, id);
    if (!status) throw new NotFoundException('meeting not found');
    // Structured like its siblings lens_extraction / search_index (findStatus).
    // It used to be a bare `summary_status` string, which meant a failed summary
    // reached the UI as "failed" with no reason attached — the row's error jsonb
    // was already selected here and then dropped on the floor.
    // NOTE: GET /meetings/:id also returns a `summary`, and that one is the whole
    // summary (topics + segments). This one is only the generation state.
    const summary = await this.summary.get(id);
    return {
      ...status,
      summary: summary
        ? { status: summary.status, model: summary.model, error: summary.error }
        : null,
    };
  }

  async extractLenses(id: string) {
    return this.lensExtraction.request(id);
  }

  async cancelLensExtraction(id: string) {
    return this.lensExtraction.cancel(id);
  }

  async reprocess(id: string, body?: { processing?: unknown; speakers?: unknown }) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    if (meeting.status !== 'done' && meeting.status !== 'failed') {
      throw new ConflictException('reprocess allowed only when status is done or failed');
    }
    // 설정 로드/resolve는 트랜잭션 진입 전에 (spec §5). JSON body라 객체 그대로 검증.
    let override: ProcessingOverride | undefined;
    if (body?.processing !== undefined) {
      const r = ProcessingOverrideSchema.safeParse(body.processing);
      if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
      override = r.data;
    }
    const speakers = this.parseSpeakers(body?.speakers);
    const global_ = await this.settings.getProcessingConfig();
    const processing = resolveProcessingConfig(global_, override, (await this.caps.get()).gpu_eligible);
    return this.db.withTransaction(async (c) => {
      const version = await this.meetings.bumpVersionForReprocess(c, id);
      const payload = buildProcessMeetingPayload({
        meetingId: id, audioKey: meeting.audio_key, processingVersion: version, reprocess: true, processing, speakers,
        // 재처리는 업로드와 달리 미루기 옵션을 노출하지 않는다 — 이미 있는 결과를
        // 새 processing_version으로 갈아끼우는 흐름이라 후속도 같이 따라가야 한다.
        followups: { lens: true, summary: true },
      });
      const job = await this.jobs.enqueue(c, { type: 'process_meeting', meetingId: id, payload });
      await this.meetings.setCurrentJob(c, id, job.id);
      return { meeting_id: id, processing_version: version, job_id: job.id };
    });
  }

  /**
   * 처리 취소 (POST /meetings/:id/cancel). 현재 job이 queued/running이면 failed(cancelled)로
   * 닫고 회의도 failed(cancelled)로 — 그러면 reprocess 가드(done|failed)를 그대로 통과해
   * 다시 돌릴 수 있다. 워커는 다음 stage 경계 또는 heartbeat에서 소유권 상실을 보고 멈춘다.
   */
  async cancel(id: string): Promise<{ meeting_id: string; job_id: string; status: 'failed' }> {
    return this.db.withTransaction(async (c) => {
      const meeting = await this.meetings.lockById(c, id);
      if (!meeting) throw new NotFoundException('meeting not found');
      const jobId = meeting.current_job_id;
      const job = jobId ? await this.jobs.findById(c, jobId) : null;
      if (!job || (job.status !== 'queued' && job.status !== 'running')) {
        throw new ConflictException('no processing in progress to cancel');
      }
      const error = JobsRepository.cancelledError(job.stage);
      await this.jobs.cancel(c, job.id, error);
      await this.meetings.markCancelled(c, id, error);
      return { meeting_id: id, job_id: job.id, status: 'failed' };
    });
  }

  async reindex(id: string) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    return this.db.withTransaction(async (c) => {
      const payload = buildIndexMeetingPayload({
        meetingId: id, processingVersion: meeting.processing_version,
      });
      const job = await this.jobs.enqueue(c, { type: 'index_meeting', meetingId: id, payload });
      return { meeting_id: id, processing_version: meeting.processing_version, job_id: job.id };
    });
  }

  async reindexMissing() {
    const env = loadEnv();
    const targets = await this.meetings.findReindexableMeetingIds(
      this.db.pool, env.SEARCH_EMBEDDING_MODEL, env.SEARCH_EMBEDDING_DIM,
    );
    return this.db.withTransaction(async (c) => {
      const jobIds: string[] = [];
      for (const t of targets) {
        const payload = buildIndexMeetingPayload({ meetingId: t.id, processingVersion: t.processing_version });
        const job = await this.jobs.enqueue(c, { type: 'index_meeting', meetingId: t.id, payload });
        jobIds.push(job.id);
      }
      return { enqueued: jobIds.length, job_ids: jobIds };
    });
  }

  async getAudioDescriptor(id: string): Promise<{ key: string; size: number }> {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    const key = meeting.normalized_key ?? meeting.audio_key;
    const stat = await this.storage.stat(key);
    return { key, size: stat.size };
  }

  audioStream(key: string, range?: { start: number; end: number }) {
    return this.storage.createReadStream(key, range);
  }

  async resolveCluster(
    meetingId: string,
    clusterId: string,
    body: { speaker_id?: string; new_name?: string },
  ): Promise<{ speaker_id: string; updated_utterances: number; merged_speaker_deleted: boolean }> {
    const hasId = body.speaker_id !== undefined && body.speaker_id !== null;
    const hasName = body.new_name !== undefined && body.new_name !== null;
    if (hasId === hasName) {
      throw new BadRequestException('exactly one of speaker_id or new_name required');
    }
    let newName: string | undefined;
    if (hasName) {
      if (typeof body.new_name !== 'string') throw new BadRequestException('new_name must be a string');
      newName = body.new_name.trim();
      if (!newName || newName.length > 100) throw new BadRequestException('new_name must be 1–100 chars');
    }
    if (hasId && !SPEAKER_ID_RE.test(String(body.speaker_id))) {
      throw new BadRequestException('speaker_id must match ^spk_[1-9][0-9]*$');
    }

    const env = loadEnv();
    return this.db.withTransaction(async (c) => {
      const cluster = await this.meetings.lockClusterInMeeting(c, meetingId, clusterId);
      if (!cluster) throw new NotFoundException('cluster not found in meeting');
      const sPrev: string | null = cluster.resolved_speaker_id;

      // lock S_prev and T (ordered by id) to serialize with PATCH /speakers/:id
      const lockIds = [sPrev, hasId ? (body.speaker_id as string) : null].filter(Boolean) as string[];
      const locked = await this.meetings.lockSpeakers(c, lockIds);
      const statusOf = (id: string | null) =>
        id ? (locked.find((r) => r.id === id)?.enrollment_status ?? null) : null;

      let finalSpeakerId: string;
      if (hasId) {
        const T = body.speaker_id as string;
        if (!locked.some((r) => r.id === T)) throw new NotFoundException('speaker not found');
        const tStatus = statusOf(T);
        if (tStatus === 'pending' || tStatus === 'failed') {
          throw new ConflictException('cannot merge into a pending/failed speaker');
        }
        finalSpeakerId = T;
      } else {
        const prevStatus = statusOf(sPrev);
        if (sPrev && prevStatus === 'provisional') {
          await this.meetings.promoteProvisional(c, sPrev, newName as string);
          finalSpeakerId = sPrev;
        } else if (sPrev === null) {
          finalSpeakerId = await this.meetings.createReadySpeaker(c, newName as string);
        } else {
          throw new ConflictException(
            'cluster already resolved; use PATCH /speakers/:id to rename or provide speaker_id to merge',
          );
        }
      }

      // unified bulk assign → updated_utterances = utterance count for this diar_label
      const updated = await this.meetings.bulkAssignSpeaker(c, meetingId, cluster.diar_label, finalSpeakerId);
      await this.meetings.setClusterResolved(c, clusterId, finalSpeakerId);
      if (cluster.has_centroid) {
        await this.meetings.upsertClusterVoiceprint(c, clusterId, finalSpeakerId, env.EMBEDDING_MODEL, env.EMBEDDING_DIM);
      }
      let mergedDeleted = false;
      if (sPrev && sPrev !== finalSpeakerId) {
        mergedDeleted = await this.meetings.deleteOrphanProvisional(c, sPrev);
      }
      return { speaker_id: finalSpeakerId, updated_utterances: updated, merged_speaker_deleted: mergedDeleted };
    });
  }
}
