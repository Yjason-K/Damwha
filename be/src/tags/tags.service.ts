import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TagsRepository } from './tags.repository';

const MEETING_ID_RE = /^mtg_[1-9][0-9]*$/;
const MAX_TAGS_PER_MEETING = 20;
const MAX_NAME_LENGTH = 30;

function parseNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new BadRequestException('names must be an array of strings');
  if (raw.length > MAX_TAGS_PER_MEETING) {
    throw new BadRequestException(`a meeting can have at most ${MAX_TAGS_PER_MEETING} tags`);
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const n of raw) {
    if (typeof n !== 'string') throw new BadRequestException('names must be an array of strings');
    const name = n.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new BadRequestException(`tag name must be 1-${MAX_NAME_LENGTH} characters`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

@Injectable()
export class TagsService {
  constructor(private readonly db: DatabaseService, private readonly repo: TagsRepository) {}

  list() {
    return this.repo.listInUse(this.db.pool);
  }

  async setForMeeting(meetingId: string, body: { names?: unknown }) {
    if (!MEETING_ID_RE.test(meetingId)) throw new NotFoundException('meeting not found');
    const names = parseNames(body?.names);
    const tags = await this.db.withTransaction(async (c) => {
      if (!(await this.repo.lockMeeting(c, meetingId))) {
        throw new NotFoundException('meeting not found');
      }
      const ensured = await this.repo.ensure(c, names);
      await this.repo.replaceMeetingTags(c, meetingId, ensured.map((t) => t.id));
      await this.repo.deleteUnused(c);
      return this.repo.findForMeeting(c, meetingId);
    });
    return { tags };
  }
}
