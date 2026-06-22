import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { buildProcessMeetingPayload } from '../contracts/job-payload.schema';
import { MeetingsRepository } from './meetings.repository';
import { loadEnv } from '../config/env';
import * as crypto from 'crypto';
import * as fs from 'fs';

const AUDIO_MIME = /^audio\//;

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

    const meetingId = crypto.randomUUID();
    const audioKey = this.storage.meetingKey(meetingId, file.originalname);
    await this.storage.saveFromTemp(audioKey, file.path);

    return this.db.withTransaction(async (c) => {
      const meeting = await c.query(
        `INSERT INTO meeting(id, title, original_filename, audio_key, recorded_at, status)
         VALUES($1,$2,$3,$4,$5,'uploaded') RETURNING *`,
        [meetingId, body.title ?? null, file.originalname, audioKey, body.recorded_at ?? null],
      );
      const payload = buildProcessMeetingPayload({
        meetingId, audioKey, processingVersion: 0, reprocess: false,
      });
      const job = await this.jobs.enqueue(c, { type: 'process_meeting', meetingId, payload });
      const updated = await this.meetings.setCurrentJob(c, meetingId, job.id);
      return updated;
    });
  }

  async list() { return this.meetings.list(this.db.pool); }

  async get(id: string) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    const utterances = await this.meetings.findUtterances(this.db.pool, id);
    return { ...meeting, utterances };
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
  ): Promise<{ speaker_id: string; updated_utterances: number }> {
    if (!body.speaker_id && !body.new_name) {
      throw new BadRequestException('speaker_id or new_name required');
    }
    const env = loadEnv();
    return this.db.withTransaction(async (c) => {
      const cluster = await this.meetings.findClusterInMeeting(c, meetingId, clusterId);
      if (!cluster) throw new NotFoundException('cluster not found in meeting');

      let speakerId: string;
      if (body.speaker_id) {
        const exists = await c.query('SELECT 1 FROM speaker WHERE id=$1', [body.speaker_id]);
        if (!exists.rowCount) throw new NotFoundException('speaker not found');
        speakerId = body.speaker_id;
      } else {
        const created = await c.query(
          `INSERT INTO speaker(name, enrollment_status) VALUES($1,'ready') RETURNING id`,
          [body.new_name],
        );
        speakerId = created.rows[0].id;
      }

      await this.meetings.setClusterResolved(c, clusterId, speakerId);
      const updated = await this.meetings.bulkAssignSpeaker(c, meetingId, cluster.diar_label, speakerId);
      if (cluster.has_centroid) {
        await this.meetings.voiceprintFromClusterCentroid(
          c, clusterId, speakerId, env.EMBEDDING_MODEL, env.EMBEDDING_DIM,
        );
      }
      return { speaker_id: speakerId, updated_utterances: updated };
    });
  }
}
