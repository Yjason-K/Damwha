import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { loadEnv } from '../config/env';
import { isIso8601 } from '../common/iso8601';
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

// 입력 검증(수동, class-validator 미도입 컨벤션). 실패 시 400. 잘못된 날짜/ID가
// 그대로 SQL 캐스트($::timestamptz, $::text[])로 흘러 500으로 터지는 것을 막는다.
function validateQuery(query: SearchQuery): void {
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 500)) {
    throw new BadRequestException('q must be a string ≤ 500 chars');
  }
  if (query.limit !== undefined && query.limit !== null && !Number.isInteger(query.limit)) {
    throw new BadRequestException('limit must be an integer');
  }
  const f = query.filters ?? {};
  for (const d of [f.dateFrom, f.dateTo]) {
    if (d != null && (typeof d !== 'string' || !isIso8601(d))) {
      throw new BadRequestException('dateFrom/dateTo must be ISO-8601');
    }
  }
  if (f.dateFrom && f.dateTo && Date.parse(f.dateFrom) >= Date.parse(f.dateTo)) {
    throw new BadRequestException('dateFrom must be < dateTo');
  }
  const idChecks: [string[] | null | undefined, RegExp][] = [
    [f.meetingIds, /^mtg_[1-9][0-9]*$/],
    [f.speakerIds, /^spk_[1-9][0-9]*$/],
  ];
  for (const [ids, re] of idChecks) {
    if (ids == null) continue;
    if (!Array.isArray(ids) || ids.length > 100) {
      throw new BadRequestException('id array must be ≤ 100 items');
    }
    if (!ids.every((x) => typeof x === 'string' && re.test(x))) {
      throw new BadRequestException('id array has a malformed id');
    }
  }
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
    validateQuery(query);
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
    // 필터형 HNSW 검색은 트랜잭션-로컬 GUC가 필요: iterative_scan=strict_order로
    // 필터 후에도 candK개 후보를 확보(날짜/화자/회의 필터 시 결과 굶음·hasMore 오류 방지),
    // ef_search는 candK 이상으로. set_config(..., true)는 트랜잭션 로컬(pgvector ≥ 0.8).
    const rows = await this.db.withTransaction(async (tx) => {
      await tx.query(`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`);
      await tx.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [
        String(Math.max(candK, 40)),
      ]);
      return this.repo.hybrid(tx, {
        q, qvec, filters, limit, candK, rrfK: env.SEARCH_RRF_K,
        model: env.SEARCH_EMBEDDING_MODEL, dim: env.SEARCH_EMBEDDING_DIM,
      });
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
