import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  async rename(id: string, body: { name?: unknown }) {
    if (typeof body?.name !== 'string') throw new BadRequestException('name must be a string');
    const name = body.name.trim();
    if (!name || name.length > 100) throw new BadRequestException('name must be 1–100 chars');
    const updated = await this.speakers.rename(this.db.pool, id, name);
    if (!updated) throw new NotFoundException('speaker not found');
    return updated;
  }

  // Un-reference blocking FKs, then delete (voiceprints cascade); finally drop
  // on-disk files. 409 while an enroll job is in flight (avoids a half-deleted
  // speaker whose enroll persist would fail its FK).
  async remove(id: string): Promise<void> {
    const deleted = await this.db.withTransaction(async (c) => {
      const speaker = await this.speakers.lockById(c, id);
      if (!speaker) return false;
      if (await this.speakers.hasActiveEnrollJob(c, id)) {
        throw new ConflictException('진행 중인 화자 등록 작업이 있어 삭제할 수 없습니다.');
      }
      // A running process_meeting job may bind this speaker at persist (FK
      // violation → pipeline retry storm), so block deletion while any is active.
      if (await this.speakers.hasActiveProcessMeetingJob(c)) {
        throw new ConflictException(
          '회의 처리가 진행 중인 동안에는 화자를 삭제할 수 없어요. 처리 완료 후 다시 시도해 주세요.',
        );
      }
      await this.speakers.unreferenceUtterances(c, id);
      await this.speakers.unreferenceClusters(c, id);
      await this.speakers.deleteById(c, id);
      return true;
    });
    if (!deleted) throw new NotFoundException('speaker not found');
    await this.storage.deleteDir(this.storage.speakerDir(id));
  }
}
