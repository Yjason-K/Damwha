import { BadRequestException, ConflictException } from '@nestjs/common';
import { MODEL_ROLES, STT_BACKENDS, SUMMARY_MODELS, WHISPER_MODELS, ModelRole, SttBackend } from '@damwha/contracts';
import { PoolClient } from 'pg';
import { modelKey } from './models-view';

/**
 * 모델 받기·삭제 요청의 검증과 job SQL (모델 다운로드 관리 스펙 §5.2~§5.4).
 * 오류 본문은 `{ statusCode, code, message }` — fe가 code로 문구를 고른다(`DemoReadOnlyGuard`와 같은 모양).
 */
export interface ModelKey {
  role: ModelRole;
  name: string;
  backend: SttBackend | null;
}

export const conflict = (code: string, message: string) => new ConflictException({ statusCode: 409, code, message });
const invalid = (message: string) => new BadRequestException({ statusCode: 400, code: 'invalid_model', message });

export function parseModelKey(
  body: unknown,
  allowed: { fixed: Record<'diarization' | 'speaker_embedding' | 'search_embedding', string>; lensModels: string[] },
): ModelKey {
  const b = (body ?? {}) as Record<string, unknown>;
  const role = b.role;
  if (typeof role !== 'string' || !(MODEL_ROLES as readonly string[]).includes(role)) {
    throw invalid(`role must be one of ${MODEL_ROLES.join(', ')}`);
  }
  const name = b.name;
  if (typeof name !== 'string' || name.length === 0) throw invalid('name is required');
  const backend = b.backend ?? null;
  if (role === 'stt') {
    if (typeof backend !== 'string' || !(STT_BACKENDS as readonly string[]).includes(backend)) {
      throw invalid(`backend is required for stt: one of ${STT_BACKENDS.join(', ')}`);
    }
    if (!(WHISPER_MODELS as readonly string[]).includes(name)) {
      throw invalid(`name for stt must be one of ${WHISPER_MODELS.join(', ')}`);
    }
    return { role, name, backend: backend as SttBackend };
  }
  if (backend !== null) throw invalid('backend is only allowed for stt');
  if (role === 'summary') {
    const ok = [...SUMMARY_MODELS, ...allowed.lensModels];
    if (!ok.includes(name)) throw invalid(`name for summary must be one of ${ok.join(', ')}`);
    return { role, name, backend: null };
  }
  const fixed = allowed.fixed[role as keyof typeof allowed.fixed];
  if (name !== fixed) throw invalid(`name for ${role} must be ${fixed}`);
  return { role: role as ModelRole, name, backend: null };
}

/**
 * 모델 job 네임스페이스 — 마이그레이션 lock(`migrate.ts`의 bigint 키)과 공간을 나눈다.
 * export하는 이유: e2e(`models-jobs.e2e-spec.ts`)가 별도 pg 클라이언트로 같은 lock을
 * 직접 잡아, `download()`가 그 lock을 실제로 기다리는지(대기자로 `pg_locks`에 나타나는지)
 * 결정적으로 검증한다 — `Promise.all` 경합만으로는 이 프로세스 하나·컨테이너 하나 환경에서
 * lock 없이도 우연히 통과할 수 있다(브리프 우려대로 실측됨, task-5-report.md 참고).
 */
export const MODEL_JOB_LOCK_NS = 72_031;

export async function lockModelKey(c: PoolClient, k: ModelKey): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [MODEL_JOB_LOCK_NS, modelKey(k.role, k.name, k.backend)]);
}

export async function activeModelJob(
  c: PoolClient,
  type: 'download_model' | 'delete_model',
  k: ModelKey,
): Promise<{ id: string; type: string; status: string } | null> {
  const r = await c.query(
    `SELECT id, type, status FROM job
      WHERE type = $1 AND status IN ('queued','running')
        AND payload->>'role' = $2 AND payload->>'name' = $3
        AND COALESCE(payload->>'backend', '') = $4
      ORDER BY created_at DESC LIMIT 1`,
    [type, k.role, k.name, k.backend ?? ''],
  );
  return r.rows[0] ?? null;
}

export async function jobRefs(
  c: { query: PoolClient['query'] },
  k: ModelKey,
  lensModels: string[],
  summaryFallback: string | null,
): Promise<string[]> {
  const r = await c.query(`SELECT * FROM model_job_refs($1, $2, $3, $4::text[], $5, NULL) AS id`, [
    k.role,
    k.name,
    k.backend,
    lensModels,
    summaryFallback,
  ]);
  return r.rows.map((x: { id: string }) => x.id);
}
