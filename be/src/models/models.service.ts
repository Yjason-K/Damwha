import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DELETABLE_ROLES } from '@damwha/contracts';
import { loadEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { buildModelJobPayload } from '../contracts/job-payload.schema';
import { SettingsService } from '../settings/settings.service';
import { ModelReadinessService } from '../system/model-readiness.service';
import { MODEL_INVENTORY_KEY, ModelInventory, fromInventoryRow } from './model-inventory';
import { ModelJobRow, ModelsView, buildModelsView, modelKey } from './models-view';
import { activeModelJob, conflict, jobRefs, lockModelKey, parseModelKey } from './model-jobs';

/**
 * `GET /models`의 읽기 (모델 다운로드 관리 스펙 §5.1)와 (D2) 받기·삭제·취소 (§5.2·§5.3). `app_setting.model_inventory`·
 * `model_readiness`·처리 설정을 **읽기만** 한다 — 이 모듈에 app_setting 쓰기가 생기면 worker
 * 단일 writer 계약이 깨진다. job 테이블의 insert/update는 이 모듈이 쓰는 유일한 쓰기다.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRepository,
    private readonly settings: SettingsService,
    private readonly readiness: ModelReadinessService,
  ) {}

  async list(): Promise<ModelsView> {
    const env = loadEnv();
    const [config, readiness, inventory] = await Promise.all([
      this.settings.getProcessingConfig(),
      this.readiness.get(),
      this.readInventory(),
    ]);
    const modelJobs = await this.readModelJobs();
    const base = {
      config,
      fixed: {
        diarization: env.DIARIZATION_MODEL,
        speaker_embedding: env.EMBEDDING_MODEL,
        search_embedding: env.SEARCH_EMBEDDING_MODEL,
      },
      lensModel: env.LENS_LLM_MODEL,
      inventory,
      readiness,
      now: Date.now(),
      modelJobs,
    };
    // 1단계: modelRefs 없이 조립해 "삭제 가능 후보"(역할이 지울 수 있고 지금 설정이 안 쓰는 행)를 뽑는다.
    const draft = buildModelsView({ ...base, modelRefs: new Set() });
    const candidates = draft.models.filter(
      (m) => (DELETABLE_ROLES as readonly string[]).includes(m.role) && m.inUseFor.length === 0,
    );
    const modelRefs = await this.readModelRefs(candidates, inventory);
    return buildModelsView({ ...base, modelRefs });
  }

  /** 못 읽으면 null("아직 스캔 안 됨") — `ModelReadinessService`와 같은 조용한 폴백. */
  private async readInventory(): Promise<ModelInventory | null> {
    try {
      const r = await this.db.pool.query('SELECT value FROM app_setting WHERE key=$1', [MODEL_INVENTORY_KEY]);
      return r.rows[0] ? fromInventoryRow(r.rows[0].value) : null;
    } catch (e) {
      this.logger.warn(`could not read model inventory: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** 논리 키마다 가장 최근 받기·삭제 job 하나. 못 읽으면 빈 배열(행마다 job: null이 된다). */
  private async readModelJobs(): Promise<ModelJobRow[]> {
    try {
      const r = await this.db.pool.query(
        `SELECT DISTINCT ON (payload->>'role', payload->>'name', COALESCE(payload->>'backend',''))
                id, type, status, error, payload->>'role' AS role, payload->>'name' AS name, payload->>'backend' AS backend
           FROM job WHERE type IN ('download_model','delete_model')
          ORDER BY payload->>'role', payload->>'name', COALESCE(payload->>'backend',''), created_at DESC`,
      );
      return r.rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        role: row.role,
        name: row.name,
        backend: row.backend ?? null,
        error:
          row.error && typeof row.error === 'object' && typeof row.error.code === 'string'
            ? { code: row.error.code, message: String(row.error.message ?? '') }
            : null,
      }));
    } catch (e) {
      this.logger.warn(`could not read model jobs: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * "삭제 가능 후보" 행이 queued/running job이 쓰는 모델인지 **쿼리 한 번**으로 판정한다(브리프 Step 5 노트).
   * 오류가 나면 후보 전부를 "쓰는 중"(deletable: false)으로 본다 — 안전한 쪽.
   */
  private async readModelRefs(
    candidates: { role: string; name: string; backend: string | null }[],
    inventory: ModelInventory | null,
  ): Promise<Set<string>> {
    if (candidates.length === 0) return new Set();
    const a = this.allowed(inventory);
    try {
      const r = await this.db.pool.query(
        `SELECT c.role AS role, c.name AS name, c.backend AS backend
           FROM unnest($1::text[], $2::text[], $3::text[]) AS c(role, name, backend)
          WHERE EXISTS (
            SELECT 1 FROM model_job_refs(c.role, c.name, NULLIF(c.backend, ''), $4::text[], $5, NULL)
          )`,
        [
          candidates.map((c) => c.role),
          candidates.map((c) => c.name),
          candidates.map((c) => c.backend ?? ''),
          a.lensModels,
          a.summaryFallback,
        ],
      );
      return new Set<string>(r.rows.map((row: { role: string; name: string; backend: string }) => modelKey(row.role, row.name, row.backend)));
    } catch (e) {
      this.logger.warn(`could not resolve model job refs — treating all deletable candidates as in use: ${e instanceof Error ? e.message : String(e)}`);
      return new Set(candidates.map((c) => modelKey(c.role, c.name, c.backend)));
    }
  }

  private allowed(inventory: ModelInventory | null) {
    const env = loadEnv();
    return {
      fixed: {
        diarization: env.DIARIZATION_MODEL,
        speaker_embedding: env.EMBEDDING_MODEL,
        search_embedding: env.SEARCH_EMBEDDING_MODEL,
      },
      lensModels: [...new Set([env.LENS_LLM_MODEL, inventory?.workerLlm.lensModel].filter((x): x is string => !!x))],
      // BE에는 LENS_LLM_MODEL(수동 재추출용)만 있고 SUMMARY_LLM_MODEL이 처리 설정의 기본 요약 모델이다 —
      // v1/v2 job의 summary_model 누락 시 worker가 실제로 쓰는 폴백과 맞춘다.
      summaryFallback: inventory?.workerLlm.summaryFallback ?? env.SUMMARY_LLM_MODEL,
    };
  }

  async download(body: unknown): Promise<{ created: boolean; job: { id: string; type: string; status: string } }> {
    const inventory = await this.readInventory();
    const a = this.allowed(inventory);
    const k = parseModelKey(body, a);
    return this.db.withTransaction(async (c) => {
      await lockModelKey(c, k);
      if (await activeModelJob(c, 'delete_model', k)) throw conflict('model_busy', '이 모델을 지우는 중이에요.');
      const existing = await activeModelJob(c, 'download_model', k);
      if (existing) return { created: false, job: existing };
      const job = await this.jobs.enqueue(c, { type: 'download_model', meetingId: null, payload: buildModelJobPayload(k) });
      return { created: true, job: { id: job.id, type: job.type, status: job.status } };
    });
  }

  async delete(body: unknown): Promise<{ created: boolean; job: { id: string; type: string; status: string } }> {
    const inventory = await this.readInventory();
    const a = this.allowed(inventory);
    const k = parseModelKey(body, a);
    if (!(DELETABLE_ROLES as readonly string[]).includes(k.role)) {
      throw conflict('model_not_deletable', '이 모델은 지울 수 없어요.');
    }
    const view = await this.list();
    const row = view.models.find((m) => m.role === k.role && m.name === k.name && m.backend === k.backend);
    if (row && row.inUseFor.length > 0) throw conflict('model_in_use_by_settings', '지금 설정에서 쓰고 있어요.');
    return this.db.withTransaction(async (c) => {
      await lockModelKey(c, k);
      if ((await jobRefs(c, k, a.lensModels, a.summaryFallback)).length > 0) {
        throw conflict('model_in_use_by_job', '처리 중인 작업이 쓰고 있어요.');
      }
      if (await activeModelJob(c, 'download_model', k)) throw conflict('model_busy', '이 모델을 받는 중이에요.');
      const existing = await activeModelJob(c, 'delete_model', k);
      if (existing) return { created: false, job: existing };
      const job = await this.jobs.enqueue(c, {
        type: 'delete_model',
        meetingId: null,
        payload: buildModelJobPayload(k),
        maxAttempts: 1,
      });
      return { created: true, job: { id: job.id, type: job.type, status: job.status } };
    });
  }

  async cancel(body: unknown): Promise<{ job: { id: string; type: string; status: string } }> {
    const jobId = (body as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') {
      throw new BadRequestException({ statusCode: 400, code: 'invalid_job', message: 'jobId is required' });
    }
    const t = await this.db.query(`SELECT type FROM job WHERE id=$1`, [jobId]);
    if (t.rows[0]?.type !== 'download_model') {
      throw new BadRequestException({ statusCode: 400, code: 'invalid_job', message: 'only download_model jobs can be cancelled' });
    }
    // 스펙 §5.3의 "queued면 바로 failed" 규칙은 **한 번도 안 돈**(attempts=0) job에만 안전하다.
    // attempts>0인 queued는 TRANSIENT로 한 번 이상 재queue된 job이다 — worker가 이미 이 repo의
    // model_readiness 항목을 썼을 수 있고, 그 키를 지우는 것은 worker/embed/llm_entry만 하는
    // app_setting 단일 writer 계약이다(§4.2, be/CLAUDE.md). 여기서 API가 바로 failed로 닫으면
    // readiness에 남은 항목이 desktop 상태 창에 "다시 시작"을 계속 띄운다(§7.4 — 최종 실패로
    // 닫힐 때 그 key를 지우는 것은 handler뿐이다). 그래서 stop_requested_at만 찍고
    // next_attempt_at을 지워 worker가 백오프를 기다리지 않고 바로 다시 claim하게 한다 — worker는
    // §7.1의 "시작 시 stop_requested_at 확인" 규칙으로 스스로 download_cancelled로 닫고
    // readiness key를 지운다(§7.2).
    const error = { code: 'download_cancelled', message: '받기를 취소했어요', kind: 'PERMANENT', stage: null };
    const closed = await this.db.query(
      `UPDATE job SET status='failed', error=$2::jsonb, updated_at=now()
        WHERE id=$1 AND status='queued' AND attempts=0 RETURNING id, type, status`,
      [jobId, JSON.stringify(error)],
    );
    if (closed.rows[0]) return { job: closed.rows[0] };
    const handoff = await this.db.query(
      `UPDATE job SET stop_requested_at=now(), next_attempt_at=NULL, updated_at=now()
        WHERE id=$1 AND status='queued' AND attempts > 0 RETURNING id, type, status`,
      [jobId],
    );
    if (handoff.rows[0]) return { job: handoff.rows[0] };
    // 그 사이 claim됐거나 이미 running — 끝내는 것은 worker다 (스펙 §5.3).
    const r = await this.db.query(
      `UPDATE job SET stop_requested_at=now(), updated_at=now() WHERE id=$1 AND status='running' RETURNING id, type, status`,
      [jobId],
    );
    if (r.rows[0]) return { job: r.rows[0] };
    throw conflict('job_not_active', '이미 끝난 작업이에요.');
  }
}
