import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { decodeOriginalName } from '../storage/upload-options';
import { JobsRepository } from '../jobs/jobs.repository';
import { buildProcessMeetingPayload, buildIndexMeetingPayload } from '../contracts/job-payload.schema';
import { MeetingsRepository, MeetingRow } from './meetings.repository';
import { loadEnv } from '../config/env';
import { nextId } from '../common/id';
import { isIso8601 } from '../common/iso8601';
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
  ) {}

  // Validation scope (Plan 1): MIME + extension + size only. Deep audio-integrity
  // validation (ffmpeg probe) happens in the Plan 2 worker normalize stage.
  async upload(file: Express.Multer.File | undefined, body: { title?: string; recorded_at?: string }) {
    if (!file) throw new BadRequestException('audio file required');
    if (!AUDIO_MIME.test(file.mimetype)) {
      await unlinkQuietly(file.path); // remove the temp file multer already wrote
      throw new BadRequestException('file must be audio/*');
    }

    const meetingId = await nextId(this.db.pool, 'meeting');
    const originalName = decodeOriginalName(file.originalname);
    const audioKey = this.storage.meetingKey(meetingId, originalName);
    await this.storage.saveFromTemp(audioKey, file.path);

    return this.db.withTransaction(async (c) => {
      const meeting = await c.query(
        `INSERT INTO meeting(id, title, original_filename, audio_key, recorded_at, status)
         VALUES($1,$2,$3,$4,$5,'uploaded') RETURNING *`,
        [meetingId, body.title ?? null, originalName, audioKey, body.recorded_at ?? null],
      );
      const payload = buildProcessMeetingPayload({
        meetingId, audioKey, processingVersion: 0, reprocess: false,
      });
      const job = await this.jobs.enqueue(c, { type: 'process_meeting', meetingId, payload });
      const updated = await this.meetings.setCurrentJob(c, meetingId, job.id);
      return updated;
    });
  }

  async setFavorite(id: string, value: boolean): Promise<MeetingRow> {
    const updated = await this.meetings.setFavorite(this.db.pool, id, value);
    if (!updated) throw new NotFoundException('meeting not found');
    return updated;
  }

  // Manual validation (no global ValidationPipe): title must be string|null,
  // recorded_at must be an ISO-8601 datetime or null.
  async update(id: string, body: { title?: unknown; recorded_at?: unknown }): Promise<MeetingRow> {
    const patch: { title?: string | null; recorded_at?: string | null } = {};
    if ('title' in body) {
      if (body.title !== null && typeof body.title !== 'string') {
        throw new BadRequestException('title must be a string or null');
      }
      patch.title = body.title as string | null;
    }
    if ('recorded_at' in body) {
      if (body.recorded_at === null) {
        patch.recorded_at = null;
      } else if (typeof body.recorded_at !== 'string' || !isIso8601(body.recorded_at)) {
        throw new BadRequestException('recorded_at must be an ISO-8601 datetime or null');
      } else {
        patch.recorded_at = body.recorded_at;
      }
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
    return { ...meeting, utterances, clusters };
  }

  async getStatus(id: string) {
    const status = await this.meetings.findStatus(this.db.pool, id);
    if (!status) throw new NotFoundException('meeting not found');
    return status;
  }

  async reprocess(id: string) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    if (meeting.status !== 'done' && meeting.status !== 'failed') {
      throw new ConflictException('reprocess allowed only when status is done or failed');
    }
    return this.db.withTransaction(async (c) => {
      const version = await this.meetings.bumpVersionForReprocess(c, id);
      const payload = buildProcessMeetingPayload({
        meetingId: id, audioKey: meeting.audio_key, processingVersion: version, reprocess: true,
      });
      const job = await this.jobs.enqueue(c, { type: 'process_meeting', meetingId: id, payload });
      await this.meetings.setCurrentJob(c, id, job.id);
      return { meeting_id: id, processing_version: version, job_id: job.id };
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
