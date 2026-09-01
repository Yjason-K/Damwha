import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NotesRepository } from './notes.repository';
import type { NoteRow } from './notes.repository';

const MEETING_ID_RE = /^mtg_[1-9][0-9]*$/;
const MAX_LENGTH = 100000;

function map(row: NoteRow) {
  return { body_md: row.body_md, updated_at: row.updated_at };
}

@Injectable()
export class NotesService {
  constructor(private readonly db: DatabaseService, private readonly repo: NotesRepository) {}

  private async assertMeeting(meetingId: string) {
    if (!MEETING_ID_RE.test(meetingId)) throw new NotFoundException('meeting not found');
    if (!(await this.repo.meetingExists(this.db.pool, meetingId))) {
      throw new NotFoundException('meeting not found');
    }
  }

  async get(meetingId: string) {
    await this.assertMeeting(meetingId);
    const row = await this.repo.find(this.db.pool, meetingId);
    // null을 그대로 반환하면 NestJS가 빈 본문을 보내고 axios가 ""로 받는다.
    // 객체로 감싸야 "메모 없음"과 "파싱 실패"가 구분된다.
    return { note: row ? map(row) : null };
  }

  /** 저장된 경우 `{ note }`, 지운 경우 `null`(컨트롤러가 204로 변환). */
  async put(meetingId: string, body: { body_md?: unknown }) {
    await this.assertMeeting(meetingId);
    if (typeof body.body_md !== 'string') throw new BadRequestException('body_md must be a string');
    if (body.body_md.length > MAX_LENGTH) {
      throw new BadRequestException(`body_md must be at most ${MAX_LENGTH} characters`);
    }
    // trim은 "다 지웠는가" 판정에만 쓴다. 저장은 원문 그대로 — 줄 끝 공백
    // 두 칸은 마크다운에서 줄바꿈이라 다듬으면 사용자의 글이 바뀐다.
    if (body.body_md.trim().length === 0) {
      await this.repo.remove(this.db.pool, meetingId);
      return null;
    }
    return { note: map(await this.repo.upsert(this.db.pool, meetingId, body.body_md)) };
  }
}
