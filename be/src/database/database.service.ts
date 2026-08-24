import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadEnv } from '../config/env';
import { listPendingMigrations } from './migrate';

/** 로그용 — 비밀번호만 가린다. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid DATABASE_URL>';
  }
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;
  constructor() {
    this.pool = new Pool({
      connectionString: loadEnv().DATABASE_URL,
      // 부팅 프로브가 죽은 DB 앞에서 기본값(무한)으로 매달리지 않게 한다
      connectionTimeoutMillis: 5000,
    });
  }

  /**
   * fail-fast: 서버가 listen하기 전에 DB에 실제로 닿는지 확인한다. 실패하면 예외를
   * 던져 부팅을 멈춘다 — 떠 있는데 모든 요청이 500인 상태보다 낫다. 미적용
   * 마이그레이션은 경고만 — 적용은 `npm run migrate`의 몫.
   */
  async onModuleInit(): Promise<void> {
    const url = maskUrl(loadEnv().DATABASE_URL);
    try {
      await this.pool.query('SELECT 1');
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`database unreachable at ${url}: ${reason}`);
    }
    // 미적용 마이그레이션 검사는 advisory — 목록을 못 읽어도(.sql이 빌드 산출물에
    // 없는 경우 등) 부팅을 막지 않는다. 연결 프로브만이 fail-fast 대상이다.
    try {
      const pending = await listPendingMigrations(this.pool);
      if (pending.length > 0) {
        this.logger.warn(
          `${pending.length} pending migration(s): ${pending.join(', ')} — run \`npm run migrate\``,
        );
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.warn(`pending migration check skipped: ${reason}`);
    }
  }

  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy() { await this.pool.end(); }
}
