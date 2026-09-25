import { z } from 'zod';
import { STT_BACKENDS } from '@damwha/contracts';

/**
 * `app_setting`의 **세 번째** 공유 행 (모델 다운로드 관리 스펙 §4.2). writer는 worker 부모의 inventory
 * 스레드 하나(`be/worker/damwha_worker/inventory.py`)이고 **API는 읽기 전용**이다.
 *
 * `model-readiness.ts`와 같은 규칙으로 **던지지 않는다** — 남이 쓴 jsonb라 옛/새 worker의 모양이 올
 * 수 있고, 그 하나 때문에 `GET /models`가 500이 되면 안 된다. 알아볼 수 없는 항목은 버린다.
 * `scanned_at`이 없으면 행 전체를 "아직 스캔 안 됨"(null)으로 본다.
 */
export const MODEL_INVENTORY_KEY = 'model_inventory';

export interface ModelInventory {
  scannedAt: string;
  repos: Record<string, { sizeBytes: number; complete: boolean }>;
  resolved: Array<{ role: 'stt'; name: string; backend: (typeof STT_BACKENDS)[number]; repoId: string }>;
  approx: Record<string, number>;
  workerLlm: { lensModel: string | null; summaryFallback: string | null };
}

const RepoSchema = z.object({
  size_bytes: z.number().finite().nonnegative(),
  complete: z.boolean(),
});
const ResolvedSchema = z.object({
  role: z.literal('stt'),
  name: z.string(),
  backend: z.enum(STT_BACKENDS),
  repo_id: z.string(),
});
const RowSchema = z.object({
  scanned_at: z.string(),
  repos: z.record(z.string(), z.unknown()).catch({}).default({}),
  resolved: z.array(z.unknown()).catch([]).default([]),
  approx: z.record(z.string(), z.unknown()).catch({}).default({}),
  worker_llm: z
    .object({
      lens_model: z.string().nullable().catch(null).default(null),
      summary_fallback: z.string().nullable().catch(null).default(null),
    })
    .catch({ lens_model: null, summary_fallback: null })
    .default({ lens_model: null, summary_fallback: null }),
});

export function fromInventoryRow(raw: unknown): ModelInventory | null {
  const row = RowSchema.safeParse(raw);
  if (!row.success) return null;
  const repos: ModelInventory['repos'] = {};
  for (const [repo, v] of Object.entries(row.data.repos)) {
    const r = RepoSchema.safeParse(v);
    if (r.success) repos[repo] = { sizeBytes: r.data.size_bytes, complete: r.data.complete };
  }
  const resolved: ModelInventory['resolved'] = [];
  for (const v of row.data.resolved) {
    const r = ResolvedSchema.safeParse(v);
    if (r.success) resolved.push({ role: 'stt', name: r.data.name, backend: r.data.backend, repoId: r.data.repo_id });
  }
  const approx: Record<string, number> = {};
  for (const [repo, v] of Object.entries(row.data.approx)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) approx[repo] = v;
  }
  return {
    scannedAt: row.data.scanned_at,
    repos,
    resolved,
    approx,
    workerLlm: {
      lensModel: row.data.worker_llm.lens_model,
      summaryFallback: row.data.worker_llm.summary_fallback,
    },
  };
}
