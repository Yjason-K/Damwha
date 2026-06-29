import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { buildEnrollSpeakerPayload } from '../contracts/job-payload.schema';
import { SpeakersRepository } from './speakers.repository';
import { nextId } from '../common/id';
import * as fs from 'fs';

const AUDIO_MIME = /^audio\//;

async function unlinkQuietly(p?: string) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch { /* already gone */ }
}

@Injectable()
export class SpeakersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly jobs: JobsRepository,
    private readonly speakers: SpeakersRepository,
  ) {}

  // Validation scope (Plan 1): MIME + size only (see MeetingsService).
  async enroll(file: Express.Multer.File | undefined, body: { name?: string }) {
    if (!body?.name) { await unlinkQuietly(file?.path); throw new BadRequestException('name required'); }
    if (!file) throw new BadRequestException('audio file required');
    if (!AUDIO_MIME.test(file.mimetype)) {
      await unlinkQuietly(file.path);
      throw new BadRequestException('file must be audio/*');
    }

    const speakerId = await nextId(this.db.pool, 'speaker');
    const audioKey = this.storage.speakerKey(speakerId, file.originalname);
    await this.storage.saveFromTemp(audioKey, file.path);

    return this.db.withTransaction(async (c) => {
      await this.speakers.create(c, speakerId, body.name!);
      const payload = buildEnrollSpeakerPayload({ speakerId, audioKey });
      const job = await this.jobs.enqueue(c, { type: 'enroll_speaker', meetingId: null, payload });
      return this.speakers.setCurrentJob(c, speakerId, job.id);
    });
  }

  list() { return this.speakers.list(this.db.pool); }

  async get(id: string) {
    const s = await this.speakers.findById(this.db.pool, id);
    if (!s) throw new NotFoundException('speaker not found');
    return s;
  }
}
