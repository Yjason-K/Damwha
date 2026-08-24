import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SavedUtterancesRepository } from './saved-utterances.repository';
import { SavedCursor, SavedUtteranceRow } from './saved-utterances.types';

const UTTERANCE_ID_RE = /^utt_[1-9][0-9]*$/;
const MEETING_ID_RE = /^mtg_[1-9][0-9]*$/;
const SAVED_ID_RE = /^sav_[1-9][0-9]*$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function cursorEncode(row: SavedUtteranceRow) {
  const payload: SavedCursor = {
    meeting_at: row.meeting_sort_at.toISOString(),
    meeting_id: row.meeting_id,
    created_at: row.created_at.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function cursorDecode(raw: string): SavedCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      !isTimestamp(value?.meeting_at)
      || typeof value?.meeting_id !== 'string' || !MEETING_ID_RE.test(value.meeting_id)
      || !isTimestamp(value?.created_at)
      || typeof value?.id !== 'string' || !SAVED_ID_RE.test(value.id)
    ) throw new Error();
    return {
      meeting_at: value.meeting_at, meeting_id: value.meeting_id,
      created_at: value.created_at, id: value.id,
    };
  } catch { throw new BadRequestException('cursor is invalid'); }
}

function map(row: SavedUtteranceRow) {
  return {
    id: row.id, utterance_id: row.utterance_id, text: row.text,
    speaker_id: row.speaker_id, speaker_name: row.speaker_name,
    start_ms: row.start_ms, created_at: row.created_at,
    meeting: { id: row.meeting_id, title: row.meeting_title, recorded_at: row.recorded_at },
  };
}

@Injectable()
export class SavedUtterancesService {
  constructor(private readonly db: DatabaseService, private readonly repo: SavedUtterancesRepository) {}

  async list(query: Record<string, string | undefined>) {
    const rawLimit = query.limit ? Number(query.limit) : DEFAULT_LIMIT;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) throw new BadRequestException('limit must be 1–100');
    const rows = await this.repo.list(this.db.pool, rawLimit, query.cursor ? cursorDecode(query.cursor) : null);
    const page = rows.slice(0, rawLimit);
    return { items: page.map(map), next_cursor: rows.length > rawLimit ? cursorEncode(page[page.length - 1]) : null };
  }

  async ids(raw: unknown) {
    const values = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    if (values.some((value) => typeof value !== 'string')) {
      throw new BadRequestException('utterance_ids are invalid');
    }
    const ids = [...new Set((values as string[]).flatMap((value) => value.split(',')).filter(Boolean))];
    if (ids.length > MAX_LIMIT || ids.some((id) => !UTTERANCE_ID_RE.test(id))) throw new BadRequestException('utterance_ids are invalid');
    return { utterance_ids: await this.repo.savedIds(this.db.pool, ids) };
  }

  async save(utteranceId: string, body: { text_snapshot?: unknown }) {
    if (!UTTERANCE_ID_RE.test(utteranceId)) throw new NotFoundException('utterance not found');
    if (typeof body.text_snapshot !== 'string') throw new BadRequestException('text_snapshot must be a string');
    const text = body.text_snapshot.trim();
    if (text.length < 1 || text.length > 4000) throw new BadRequestException('text_snapshot must be 1–4000 characters');
    return this.db.withTransaction(async (client) => {
      const candidate = await this.repo.findSaveCandidate(client, utteranceId);
      if (!candidate) throw new NotFoundException('utterance not found');
      const id = await this.repo.save(client, { utteranceId, meetingId: candidate.meeting_id, text, speakerName: candidate.speaker_name, startMs: candidate.start_ms });
      return map((await this.repo.findById(client, id))!);
    });
  }

  async remove(utteranceId: string) {
    if (!UTTERANCE_ID_RE.test(utteranceId)) throw new NotFoundException('utterance not found');
    await this.repo.remove(this.db.pool, utteranceId);
  }
}
