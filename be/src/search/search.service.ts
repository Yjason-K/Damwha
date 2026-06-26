import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { loadEnv } from '../config/env';
import { EmbedClient } from './embed.client';
import { SearchFilters, SearchRepository, SearchRow } from './search.repository';

export interface SearchQuery {
  q?: string;
  filters?: Partial<SearchFilters>;
  limit?: number;
}
export interface SearchResult {
  utteranceId: string;
  meetingId: string;
  meetingTitle: string | null;
  recordedAt: Date | null;
  speaker: { id: string; name: string } | null;
  diarLabel: string;
  startMs: number;
  endMs: number;
  text: string | null;
  score: number;
}
export interface SearchResponse {
  mode: 'hybrid' | 'keyword' | 'browse';
  semantic: boolean;
  hasMore: boolean;
  results: SearchResult[];
}

// DB row(snake_case) → API DTO(camelCase, nested speaker). 스펙 §5.1 계약.
function toResult(r: SearchRow): SearchResult {
  return {
    utteranceId: r.utterance_id,
    meetingId: r.meeting_id,
    meetingTitle: r.meeting_title,
    recordedAt: r.recorded_at,
    speaker: r.speaker_id ? { id: r.speaker_id, name: r.speaker_name as string } : null,
    diarLabel: r.diar_label,
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text,
    score: r.score,
  };
}

@Injectable()
export class SearchService {
  private readonly env = loadEnv();

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: SearchRepository,
    private readonly embed: EmbedClient,
  ) {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    const env = this.env;
    const q = (query.q ?? '').trim();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const candK = Math.max(env.SEARCH_CANDIDATE_K, limit * 5);
    const filters: SearchFilters = {
      dateFrom: query.filters?.dateFrom ?? null,
      dateTo: query.filters?.dateTo ?? null,
      speakerIds: query.filters?.speakerIds ?? null,
      meetingIds: query.filters?.meetingIds ?? null,
    };

    if (q === '') {
      const rows = await this.repo.browse(this.db.pool, { filters, limit });
      return this.shape('browse', false, rows, limit);
    }

    const qvec = await this.embed.embed(q);
    if (qvec === null) {
      const rows = await this.repo.keyword(this.db.pool, { q, filters, limit, candK });
      return this.shape('keyword', false, rows, limit);
    }
    const rows = await this.repo.hybrid(this.db.pool, {
      q, qvec, filters, limit, candK, rrfK: env.SEARCH_RRF_K,
      model: env.SEARCH_EMBEDDING_MODEL, dim: env.SEARCH_EMBEDDING_DIM,
    });
    return this.shape('hybrid', true, rows, limit);
  }

  private shape(
    mode: SearchResponse['mode'], semantic: boolean, rows: SearchRow[], limit: number,
  ): SearchResponse {
    const hasMore = rows.length > limit;
    return { mode, semantic, hasMore, results: rows.slice(0, limit).map(toResult) };
  }
}
