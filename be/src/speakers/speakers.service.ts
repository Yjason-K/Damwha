import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { buildEnrollSpeakerPayload } from '../contracts/job-payload.schema';
import { SpeakersRepository } from './speakers.repository';
import { nextId } from '../common/id';
import * as fs from 'fs';

const AUDIO_MIME = /^audio\//;
const SPEAKER_ID_RE = /^spk_[1-9][0-9]*$/;

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

  // 등록 상태는 따지지 않는다 — 회의에서 자동으로 생긴 provisional 화자도 '나'일 수 있다.
  async setMe(id: string) {
    return this.db.withTransaction(async (c) => {
      if (!(await this.speakers.lockById(c, id))) throw new NotFoundException('speaker not found');
      return this.speakers.setMe(c, id);
    });
  }

  async clearMe(id: string): Promise<void> {
    if (!(await this.speakers.clearMe(this.db.pool, id))) throw new NotFoundException('speaker not found');
  }

  // id를 into에 합치고 id를 지운다. 회의 단위 resolve(clusters/:id/resolve)의 전역판이다 — 같은
  // 사람이 여러 회의에서 서로 다른 화자로 남았을 때 한 번에 묶는다. into는 성문이 있는
  // ready/provisional만 받는다(resolve와 같은 규칙). 삭제와 같은 이유로 등록·회의 처리 중엔 409.
  async merge(id: string, body: { into?: unknown }) {
    if (typeof body?.into !== 'string' || !SPEAKER_ID_RE.test(body.into)) {
      throw new BadRequestException('into must match ^spk_[1-9][0-9]*$');
    }
    const into = body.into;
    if (into === id) throw new BadRequestException('cannot merge a speaker into itself');
    const result = await this.db.withTransaction(async (c) => {
      const [first, second] = [id, into].sort();
      const a = await this.speakers.lockById(c, first);
      const b = await this.speakers.lockById(c, second);
      const from = a?.id === id ? a : b?.id === id ? b : null;
      const target = a?.id === into ? a : b?.id === into ? b : null;
      if (!from || !target) throw new NotFoundException('speaker not found');
      if (target.enrollment_status !== 'ready' && target.enrollment_status !== 'provisional') {
        throw new ConflictException('cannot merge into a pending/failed speaker');
      }
      if (await this.speakers.hasActiveEnrollJob(c, id)) {
        throw new ConflictException('진행 중인 화자 등록 작업이 있어 병합할 수 없습니다.');
      }
      if (await this.speakers.hasActiveProcessMeetingJob(c)) {
        throw new ConflictException(
          '회의 처리가 진행 중인 동안에는 화자를 병합할 수 없어요. 처리 완료 후 다시 시도해 주세요.',
        );
      }
      const { utterances } = await this.speakers.mergeInto(c, id, into);
      await this.speakers.deleteById(c, id);
      // '나'는 사람에 붙는 표식이라 합쳐진 쪽으로 따라간다. from을 지운 뒤라 단일 '나' 인덱스와 부딪히지 않는다.
      if (from.is_me) await this.speakers.setMe(c, into);
      return { speaker: await this.speakers.findById(c, into), merged_utterances: utterances };
    });
    await this.storage.deleteDir(this.storage.speakerDir(id));
    return result;
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
      await this.speakers.unreferenceSuggestions(c, id);
      await this.speakers.deleteById(c, id);
      return true;
    });
    if (!deleted) throw new NotFoundException('speaker not found');
    await this.storage.deleteDir(this.storage.speakerDir(id));
  }
}
