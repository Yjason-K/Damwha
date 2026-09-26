import {
  DELETABLE_ROLES,
  ModelRole,
  SUMMARY_MODELS,
  SttBackend,
  WHISPER_MODELS,
} from '@damwha/contracts';
import { ProcessingConfig } from '../settings/presets';
import { ModelReadiness, ModelReadinessEntry } from '../system/model-readiness';
import { ModelInventory } from './model-inventory';

/**
 * `GET /models`의 순수 조립 (모델 다운로드 관리 스펙 §5.1). DB·env를 모른다 — 서비스가 읽어 넘긴다.
 *
 * 멈춤 기준은 fe `MODEL_STALL_MS`·desktop `STALL_MS`와 **같은 값**이다. `fromReadinessRow`는 멈춤을
 * 판정하지 않아 여기에 세 번째 사본이 생긴다 — `test/models-view.spec.ts`가 세 파일을 대조한다.
 */
export const MODEL_STALL_MS = 120_000;

export type InUse = 'stt' | 'summary' | 'lens' | 'fixed';
export type Installed = 'yes' | 'no' | 'partial' | 'unknown';

/** (D2) 행이 싣는, 그 논리 키의 가장 최근 모델 job (모델 다운로드 관리 스펙 §5.1·§5.2). */
export interface ModelJobRef {
  id: string;
  type: 'download_model' | 'delete_model';
  status: 'queued' | 'running' | 'done' | 'failed';
  error: { code: string; message: string } | null;
}
/** 서비스가 `job` 테이블에서 논리 키마다 하나씩 골라 넘기는 입력 행. */
export interface ModelJobRow extends ModelJobRef {
  role: ModelRole;
  name: string;
  backend: SttBackend | null;
  /**
   * (D2 최종 리뷰) 이 job이 마지막으로 갱신된 시각. `pending` 판정에만 쓰고 fe로는 보내지 않는다
   * (`ModelJobRef`에는 없다) — 끝난(done/failed) job이 마지막 inventory 스캔보다 새로우면, 삭제·
   * 최종 실패로 그 repo의 readiness key가 지워진 뒤라도 화면이 계속 폴링하게 한다(§5.1).
   */
  updatedAt: string;
}

export interface ModelRow {
  role: ModelRole;
  name: string;
  backend: SttBackend | null;
  repoId: string | null;
  inUseFor: InUse[];
  installed: Installed;
  sizeBytes: number | null;
  approxBytes: number | null;
  downloading: { bytesDone: number; bytesTotal: number } | null;
  deletable: boolean;
  /** (D2) 이 논리 키의 마지막 받기·삭제 job. 없으면 null. */
  job: ModelJobRef | null;
}

export interface ModelsView {
  scannedAt: string | null;
  totalBytes: number | null;
  pending: boolean;
  models: ModelRow[];
  /** (D2) worker가 잰 남은 용량. 못 읽었거나 아직 없으면 null. */
  freeBytes: number | null;
}

/** 논리 키 — 받기·삭제·job 참조의 공통 식별자 (모델 다운로드 관리 스펙 §5.2). */
export const modelKey = (role: string, name: string, backend: string | null) => `${role}:${name}:${backend ?? ''}`;

export interface ModelsViewInput {
  config: Pick<ProcessingConfig, 'whisper_model' | 'devices' | 'summary_model'>;
  fixed: { diarization: string; speaker_embedding: string; search_embedding: string };
  /** BE env `LENS_LLM_MODEL` (수동 재추출). worker 값은 inventory `workerLlm`에서 온다. */
  lensModel: string;
  inventory: ModelInventory | null;
  readiness: ModelReadiness;
  now: number;
  /** (D2) 논리 키마다 가장 최근 job 하나 — 서비스가 고른다. */
  modelJobs: ModelJobRow[];
  /** (D2) queued/running job이 쓰는 모델의 논리 키 — 서비스가 `model_job_refs`로 채운다. */
  modelRefs: Set<string>;
}

export function isDownloadingNow(e: ModelReadinessEntry, now: number): boolean {
  if (e.state !== 'downloading' || e.updatedAt === null) return false;
  const t = Date.parse(e.updatedAt);
  // 읽을 수 없는 시각은 "받는 중"이 아니다 — 진행 표시가 영영 남지 않게(fe와 같은 규칙).
  return !Number.isNaN(t) && now - t <= MODEL_STALL_MS;
}

const backendOf = (stt: 'cpu' | 'gpu'): SttBackend => (stt === 'gpu' ? 'mlx' : 'faster');

export function buildModelsView(input: ModelsViewInput): ModelsView {
  const { config, fixed, inventory, readiness, now, modelJobs, modelRefs } = input;
  const current = backendOf(config.devices.stt);
  const lensModels = [...new Set([input.lensModel, inventory?.workerLlm.lensModel].filter((x): x is string => !!x))];
  const readinessByKey = new Map(readiness.entries.map((e) => [e.key, e]));
  const jobByKey = new Map(modelJobs.map((j) => [modelKey(j.role, j.name, j.backend), j]));

  const resolve = (name: string, backend: SttBackend): string | null =>
    inventory?.resolved.find((r) => r.name === name && r.backend === backend)?.repoId ?? null;

  const row = (role: ModelRole, name: string, backend: SttBackend | null, repoId: string | null, inUseFor: InUse[]): ModelRow => {
    const repo = repoId && inventory ? inventory.repos[repoId] : undefined;
    const installed: Installed =
      !inventory || !repoId ? 'unknown' : !repo ? 'no' : repo.complete ? 'yes' : 'partial';
    const r = repoId ? readinessByKey.get(repoId) : undefined;
    const key = modelKey(role, name, backend);
    const j = jobByKey.get(key);
    return {
      role,
      name,
      backend,
      repoId,
      inUseFor,
      installed,
      sizeBytes: repo ? repo.sizeBytes : null,
      approxBytes: repoId ? inventory?.approx[repoId] ?? null : null,
      downloading: r && isDownloadingNow(r, now) ? { bytesDone: r.bytesDone, bytesTotal: r.bytesTotal } : null,
      deletable: (DELETABLE_ROLES as readonly string[]).includes(role) && inUseFor.length === 0 && !modelRefs.has(key),
      job: j ? { id: j.id, type: j.type, status: j.status, error: j.error } : null,
    };
  };

  const models: ModelRow[] = [];
  const other: SttBackend = current === 'mlx' ? 'faster' : 'mlx';
  for (const name of WHISPER_MODELS) {
    const inUse: InUse[] = name === config.whisper_model ? ['stt'] : [];
    models.push(row('stt', name, current, resolve(name, current), inUse));
  }
  for (const name of WHISPER_MODELS) {
    const repoId = resolve(name, other);
    if (repoId && inventory?.repos[repoId]) models.push(row('stt', name, other, repoId, []));
  }
  const summaryNames = [...SUMMARY_MODELS, ...lensModels.filter((m) => !(SUMMARY_MODELS as readonly string[]).includes(m))];
  for (const name of summaryNames) {
    const inUse: InUse[] = [];
    if (name === config.summary_model) inUse.push('summary');
    if (lensModels.includes(name)) inUse.push('lens');
    models.push(row('summary', name, null, name, inUse));
  }
  models.push(row('diarization', fixed.diarization, null, fixed.diarization, ['fixed']));
  models.push(row('speaker_embedding', fixed.speaker_embedding, null, fixed.speaker_embedding, ['fixed']));
  models.push(row('search_embedding', fixed.search_embedding, null, fixed.search_embedding, ['fixed']));

  const scanned = inventory ? Date.parse(inventory.scannedAt) : NaN;
  const catalogRepos = new Set(models.map((m) => m.repoId).filter((x): x is string => !!x));
  const settling =
    !Number.isNaN(scanned) &&
    readiness.entries.some((e) => {
      if (!catalogRepos.has(e.key) || e.updatedAt === null) return false;
      const t = Date.parse(e.updatedAt);
      return !Number.isNaN(t) && t > scanned;
    });
  // (D2 최종 리뷰) 삭제·최종 실패는 그 repo의 readiness key를 지운다 — 그러면 위 settling 조건이
  // 볼 신호가 없어져, 삭제 직후 활성 job도 없고 downloading도 없는 채로 pending이 꺼져 버린다
  // (fe useModels가 폴링을 멈추고 행이 옛 상태에 굳는다). job.updated_at을 대신 본다.
  const finishedJobSettling = modelJobs.some((j) => {
    if (j.status !== 'done' && j.status !== 'failed') return false;
    if (!inventory) return true;
    const t = Date.parse(j.updatedAt);
    return !Number.isNaN(t) && t > scanned;
  });

  return {
    scannedAt: inventory?.scannedAt ?? null,
    totalBytes: inventory ? Object.values(inventory.repos).reduce((s, r) => s + r.sizeBytes, 0) : null,
    pending:
      models.some((m) => m.downloading !== null) ||
      settling ||
      modelJobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      finishedJobSettling,
    models,
    freeBytes: inventory?.freeBytes ?? null,
  };
}
