import { z } from 'zod';

/**
 * `app_setting`의 **두 번째** 공유 행 (Phase 4 스펙 §6.9). `worker_capabilities`와 같은 방향 —
 * worker·embed·`llm_entry`가 쓰고 **API는 읽기 전용**이다. 이 파일에 쓰기 경로가 생기면 그 계약이
 * 깨진다: 세 writer가 한 SQL 문의 원자적 merge로 갱신하는 행을 API가 읽고-고쳐-쓰면 서로를 지운다.
 *
 * 원본은 `be/worker/damwha_worker/db/core.py`의 `merge_model_readiness`이고, 같은 값을 앱 상태 창도
 * 읽는다(`desktop/src/services/model-readiness.ts` — 그쪽은 번들 psql로 직접 읽는다). 두 리더가
 * **같은 이름**을 쓰도록 여기서도 snake_case를 camelCase로 편다.
 *
 * 워커가 나중에 필드를 더 붙여도 API가 깨지지 않도록 strict가 아니다 — `worker_capabilities`와 같은
 * 이유다(`capabilities.ts`의 WorkerCapabilitiesSchema).
 */
export const MODEL_READINESS_KEY = 'model_readiness';

const StateSchema = z.enum(['downloading', 'ready', 'failed']);
const ErrorKindSchema = z.enum(['PERMANENT', 'TRANSIENT']);

/**
 * 한 모델(HF repo id)의 준비 상태. 빠진 필드는 기본값으로 채운다 — worker는 항목을 **부분만**
 * merge할 수 있고(진행 갱신은 bytes와 state만 싣는다), 없는 필드 때문에 행 전체를 버리면 화면이
 * 받는 중인 모델을 못 본다.
 */
const EntrySchema = z.object({
  state: StateSchema,
  bytes_done: z.number().finite().nonnegative().catch(0).default(0),
  bytes_total: z.number().finite().nonnegative().catch(0).default(0),
  writer: z.string().catch('').default(''),
  attempt: z.number().int().catch(1).default(1),
  started_at: z.string().nullable().catch(null).default(null),
  updated_at: z.string().nullable().catch(null).default(null),
  error: z.string().nullable().catch(null).default(null),
  error_kind: ErrorKindSchema.nullable().catch(null).default(null),
});

const RowSchema = z.object({
  updated_at: z.string().nullable().catch(null).default(null),
  /** 배열이 아니라 key 맵이다 — merge가 자연스럽고 순서에 의미가 없다 (스펙 §6.9). */
  entries: z.record(z.string(), z.unknown()).catch({}).default({}),
});

export interface ModelReadinessEntry {
  /** `entries` 맵의 key. HF repo id다. */
  key: string;
  state: z.infer<typeof StateSchema>;
  bytesDone: number;
  /** 모르는 구간은 0이다. 그때 화면은 "받는 중"만 보인다 (스펙 §6.9). */
  bytesTotal: number;
  /** ISO8601. 읽는 쪽이 무진행("중단됨")을 이 값으로 판정한다. */
  startedAt: string | null;
  updatedAt: string | null;
  /** 어느 프로세스가 받고 있나 — worker는 `WORKER_ID`, embed는 `"embed"` (스펙 §6.9, 판정 R-9a). */
  writer: string;
  attempt: number;
  /** `"<code>: <message>"`. 문구를 고르는 것은 읽는 쪽이고, 그 근거는 code다 (판정 R-11a). */
  error: string | null;
  errorKind: z.infer<typeof ErrorKindSchema> | null;
}

export interface ModelReadiness {
  updatedAt: string | null;
  entries: ModelReadinessEntry[];
}

/** 행이 없거나 읽을 수 없을 때. "받는 중인 모델이 없다"와 같은 뜻이다. */
export const EMPTY_MODEL_READINESS: ModelReadiness = Object.freeze({
  updatedAt: null,
  entries: [],
});

/**
 * 저장된 jsonb를 응답 모양으로. **던지지 않는다** — 들어오는 것은 남이 쓴 jsonb라 손으로 넣은
 * 스칼라·옛 스키마가 올 수 있고, 그 하나 때문에 설정 조회가 500이 되면 안 된다. 알아볼 수 없는
 * 항목은 조용히 버린다(desktop의 `parseModelReadiness`와 같은 규칙).
 */
export function fromReadinessRow(raw: unknown): ModelReadiness {
  const row = RowSchema.safeParse(raw);
  if (!row.success) return EMPTY_MODEL_READINESS;
  const entries: ModelReadinessEntry[] = [];
  for (const [key, value] of Object.entries(row.data.entries)) {
    const parsed = EntrySchema.safeParse(value);
    // 모르는 state는 채워 넣을 기본값이 없다 — "받는 중"으로 읽으면 진행 표시가 영영 남고
    // "실패"로 읽으면 멀쩡한 준비를 실패로 적는다.
    if (!parsed.success) continue;
    const e = parsed.data;
    entries.push({
      key,
      state: e.state,
      bytesDone: e.bytes_done,
      bytesTotal: e.bytes_total,
      startedAt: e.started_at,
      updatedAt: e.updated_at,
      writer: e.writer,
      attempt: e.attempt,
      error: e.error,
      errorKind: e.error_kind,
    });
  }
  return { updatedAt: row.data.updated_at, entries };
}
