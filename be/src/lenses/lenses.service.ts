import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { LensesRepository } from './lenses.repository';
import {
  EvidenceRelation, EvidenceRow, LENS_KINDS, LensCompletionStatus, LensCursor,
  LensItemRow, LensKind, LensLifecycleStatus,
} from './lens.types';

type Exec = Pool | PoolClient;

const MEETING_ID_RE = /^mtg_[1-9][0-9]*$/;
const SPEAKER_ID_RE = /^spk_[1-9][0-9]*$/;
const UTTERANCE_ID_RE = /^utt_[1-9][0-9]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function trimText(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('text must be a string');
  const text = value.trim();
  if (text.length < 1 || text.length > 1000) throw new BadRequestException('text must be 1–1000 characters');
  return text;
}

function encodeCursor(row: LensItemRow): string {
  const payload: LensCursor = { updated_at: row.updated_at.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(raw: string): LensCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.updated_at !== 'string' || typeof parsed?.id !== 'string') throw new Error('shape');
    return { updated_at: parsed.updated_at, id: parsed.id };
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
}

@Injectable()
export class LensesService {
  constructor(private readonly db: DatabaseService, private readonly repo: LensesRepository) {}

  async list(query: Record<string, string | undefined>) {
    const filters = {
      lifecycle_status: this.parseEnum<LensLifecycleStatus>(
        query.lifecycle_status, ['active', 'archived'], 'active', 'lifecycle_status',
      ),
      completion_status: this.parseEnum<LensCompletionStatus>(
        query.completion_status, ['open', 'done'], 'open', 'completion_status',
      ),
      kind: query.kind ? this.parseEnum<LensKind>(query.kind, [...LENS_KINDS], undefined, 'kind') : undefined,
      meeting_id: this.parseIdFilter(query.meeting_id, MEETING_ID_RE, 'meeting_id'),
      speaker_id: this.parseIdFilter(query.speaker_id, SPEAKER_ID_RE, 'speaker_id'),
      date_from: this.parseDateFilter(query.date_from, 'date_from'),
      date_to: this.parseDateFilter(query.date_to, 'date_to'),
      limit: this.parseLimit(query.limit),
    };
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const rows = await this.repo.list(this.db.pool, filters, cursor);
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const items = await this.hydrateMany(this.db.pool, page);
    return { items, next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
  }

  async listForMeeting(meetingId: string) {
    if (!(await this.repo.meetingExists(this.db.pool, meetingId))) {
      throw new NotFoundException('meeting not found');
    }
    const rows = await this.repo.listActiveForMeeting(this.db.pool, meetingId);
    return { items: await this.hydrateMany(this.db.pool, rows) };
  }

  async create(body: {
    meeting_id?: unknown; kind?: unknown; text?: unknown; assignee_speaker_id?: unknown; due_at?: unknown;
  }) {
    if (typeof body.meeting_id !== 'string' || !MEETING_ID_RE.test(body.meeting_id)) {
      throw new BadRequestException('meeting_id must match ^mtg_[1-9][0-9]*$');
    }
    const kind = this.parseEnum<LensKind>(body.kind, [...LENS_KINDS], undefined, 'kind');
    const text = trimText(body.text);
    const assignee = this.parseAssignee(body.assignee_speaker_id);
    const dueAt = this.parseDue(body.due_at);

    return this.db.withTransaction(async (c) => {
      if (!(await this.repo.meetingExists(c, body.meeting_id as string))) {
        throw new NotFoundException('meeting not found');
      }
      await this.assertAssigneeMembership(c, body.meeting_id as string, assignee);
      const id = await this.repo.insert(c, {
        meetingId: body.meeting_id as string, kind, text, assigneeSpeakerId: assignee, dueAt,
      });
      return this.hydrate(c, id);
    });
  }

  async update(id: string, body: {
    text?: unknown; kind?: unknown; assignee_speaker_id?: unknown; due_at?: unknown;
  }) {
    const patch: { text?: string; kind?: string; assignee_speaker_id?: string | null; due_at?: string | null } = {};
    if ('text' in body) patch.text = trimText(body.text);
    if ('kind' in body) patch.kind = this.parseEnum<LensKind>(body.kind, [...LENS_KINDS], undefined, 'kind');
    if ('assignee_speaker_id' in body) patch.assignee_speaker_id = this.parseAssignee(body.assignee_speaker_id);
    if ('due_at' in body) patch.due_at = this.parseDue(body.due_at);

    return this.db.withTransaction(async (c) => {
      const item = await this.repo.findById(c, id);
      if (!item) throw new NotFoundException('lens item not found');
      if (patch.assignee_speaker_id) {
        await this.assertAssigneeMembership(c, item.meeting_id, patch.assignee_speaker_id);
      }
      await this.repo.update(c, id, patch);
      return this.hydrate(c, id);
    });
  }

  async setCompletion(id: string, status: LensCompletionStatus) {
    return this.db.withTransaction(async (c) => {
      if (!(await this.repo.setCompletion(c, id, status))) throw new NotFoundException('lens item not found');
      return this.hydrate(c, id);
    });
  }

  async archive(id: string): Promise<void> {
    const ok = await this.db.withTransaction((c) => this.repo.archive(c, id));
    if (!ok) throw new NotFoundException('lens item not found');
  }

  async addEvidence(id: string, body: { utterance_id?: unknown; relation?: unknown }) {
    if (typeof body.utterance_id !== 'string' || !UTTERANCE_ID_RE.test(body.utterance_id)) {
      throw new BadRequestException('utterance_id must match ^utt_[1-9][0-9]*$');
    }
    const relation = this.parseEnum<EvidenceRelation>(
      body.relation, ['primary', 'supporting'], undefined, 'relation',
    );
    return this.db.withTransaction(async (c) => {
      const item = await this.repo.findById(c, id);
      if (!item) throw new NotFoundException('lens item not found');
      if (!(await this.repo.utteranceInMeeting(c, item.meeting_id, body.utterance_id as string))) {
        throw new BadRequestException('utterance does not belong to this item’s meeting');
      }
      if (relation === 'primary') {
        const existingPrimary = await this.repo.findPrimaryEvidenceUtteranceId(c, id);
        if (existingPrimary && existingPrimary !== body.utterance_id) {
          throw new ConflictException('item already has a primary evidence');
        }
      }
      await this.repo.upsertEvidence(c, id, body.utterance_id as string, relation);
      await this.repo.touch(c, id);
      return this.hydrate(c, id);
    });
  }

  async removeEvidence(id: string, utteranceId: string) {
    return this.db.withTransaction(async (c) => {
      const item = await this.repo.findById(c, id);
      if (!item) throw new NotFoundException('lens item not found');
      // Delete first, then guard: throwing rolls the delete back atomically.
      const relation = await this.repo.deleteEvidence(c, id, utteranceId);
      if (relation === null) throw new NotFoundException('evidence not found');
      if (relation === 'primary' && item.source === 'ai' && item.lifecycle_status === 'active') {
        throw new ConflictException('cannot remove the primary evidence of an active AI item');
      }
      await this.repo.touch(c, id);
      return this.hydrate(c, id);
    });
  }

  // --- helpers --------------------------------------------------------------
  private async hydrate(exec: Exec, id: string) {
    const row = await this.repo.findById(exec, id);
    if (!row) throw new NotFoundException('lens item not found');
    const evidence = await this.repo.findEvidence(exec, [id]);
    return toItem(row, evidence);
  }

  private async hydrateMany(exec: Exec, rows: LensItemRow[]) {
    const evidence = await this.repo.findEvidence(exec, rows.map((r) => r.id));
    return rows.map((r) => toItem(r, evidence.filter((e) => e.lens_item_id === r.id)));
  }

  private async assertAssigneeMembership(exec: Exec, meetingId: string, speakerId: string | null) {
    if (speakerId && !(await this.repo.speakerHasUtteranceInMeeting(exec, meetingId, speakerId))) {
      throw new BadRequestException('assignee_speaker_id has no utterance in this meeting');
    }
  }

  private parseAssignee(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !SPEAKER_ID_RE.test(value)) {
      throw new BadRequestException('assignee_speaker_id must match ^spk_[1-9][0-9]*$');
    }
    return value;
  }

  private parseDue(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !isValidDate(value)) {
      throw new BadRequestException('due_at must be a valid YYYY-MM-DD date');
    }
    return value;
  }

  private parseEnum<T extends string>(value: unknown, allowed: readonly string[], fallback: T | undefined, field: string): T {
    if (value === undefined) {
      if (fallback === undefined) throw new BadRequestException(`${field} is required`);
      return fallback;
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new BadRequestException(`${field} must be one of ${allowed.join(', ')}`);
    }
    return value as T;
  }

  private parseIdFilter(value: string | undefined, re: RegExp, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (!re.test(value)) throw new BadRequestException(`${field} is invalid`);
    return value;
  }

  private parseDateFilter(value: string | undefined, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (!isValidDate(value)) throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
    return value;
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) return DEFAULT_LIMIT;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new BadRequestException('limit must be a positive integer');
    return Math.min(n, MAX_LIMIT);
  }
}

// snake_case response object: the item row with a nested meeting and ordered evidence.
function toItem(row: LensItemRow, evidence: EvidenceRow[]) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    source: row.source,
    user_modified: row.user_modified,
    completion_status: row.completion_status,
    lifecycle_status: row.lifecycle_status,
    meeting_id: row.meeting_id,
    assignee_speaker_id: row.assignee_speaker_id,
    due_at: row.due_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    meeting: { id: row.meeting_id, title: row.meeting_title },
    evidence: evidence.map((e) => ({ relation: e.relation, utterance: e.utterance })),
  };
}
