import {
  EMPTY_MODEL_READINESS,
  MODEL_READINESS_KEY,
  fromReadinessRow,
} from '../src/system/model-readiness';
import { ModelReadinessService } from '../src/system/model-readiness.service';

const ROW = {
  updated_at: '2026-09-18T01:02:03.456789Z',
  entries: {
    'BAAI/bge-m3': {
      state: 'downloading',
      bytes_done: 1024,
      bytes_total: 4096,
      writer: 'embed',
      attempt: 1,
      started_at: '2026-09-18T01:00:00.000000Z',
      updated_at: '2026-09-18T01:02:03.456789Z',
      error: null,
      error_kind: null,
    },
  },
};

describe('fromReadinessRow', () => {
  it('워커가 쓴 snake_case 한 행을 화면이 읽는 모양으로 편다', () => {
    expect(fromReadinessRow(ROW)).toEqual({
      updatedAt: '2026-09-18T01:02:03.456789Z',
      entries: [
        {
          key: 'BAAI/bge-m3',
          state: 'downloading',
          bytesDone: 1024,
          bytesTotal: 4096,
          writer: 'embed',
          attempt: 1,
          startedAt: '2026-09-18T01:00:00.000000Z',
          updatedAt: '2026-09-18T01:02:03.456789Z',
          error: null,
          errorKind: null,
        },
      ],
    });
  });

  it('실패 항목의 error·error_kind를 그대로 싣는다 — 문구 판정은 읽는 쪽이 한다', () => {
    const readiness = fromReadinessRow({
      entries: {
        'pyannote/speaker-diarization-community-1': {
          state: 'failed',
          error: 'hf_gate_not_accepted: Hugging Face refused access (403)',
          error_kind: 'PERMANENT',
        },
      },
    });
    expect(readiness.entries[0].error).toBe(
      'hf_gate_not_accepted: Hugging Face refused access (403)',
    );
    expect(readiness.entries[0].errorKind).toBe('PERMANENT');
    // 빠진 필드는 기본값으로 채운다 — worker가 부분만 merge한 행도 읽혀야 한다.
    expect(readiness.entries[0].bytesTotal).toBe(0);
    expect(readiness.entries[0].attempt).toBe(1);
  });

  it('알아볼 수 없는 값에는 던지지 않고 비어 있는 준비 상태를 돌려준다', () => {
    for (const bad of [null, undefined, 3, 'x', [], { entries: 1 }]) {
      expect(fromReadinessRow(bad)).toEqual(EMPTY_MODEL_READINESS);
    }
  });

  it('모르는 state의 항목만 버리고 나머지는 남긴다', () => {
    const readiness = fromReadinessRow({
      entries: {
        good: { state: 'ready' },
        bad: { state: 'sideways' },
        alsoBad: 7,
      },
    });
    expect(readiness.entries.map((e) => e.key)).toEqual(['good']);
  });

  it('worker가 필드를 더 붙여도 깨지지 않는다 (worker_capabilities와 같은 비-strict 계약)', () => {
    const readiness = fromReadinessRow({
      entries: { k: { state: 'ready', future_field: 'x' } },
    });
    expect(readiness.entries).toHaveLength(1);
    expect(readiness.entries[0]).not.toHaveProperty('future_field');
  });
});

describe('ModelReadinessService', () => {
  const svc = (query: jest.Mock) => new ModelReadinessService({ pool: { query } } as never);

  it('app_setting의 그 행 하나를 읽는다 — 쓰지 않는다', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ value: ROW }] });
    const readiness = await svc(query).get();
    expect(readiness.entries[0].key).toBe('BAAI/bge-m3');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/^\s*SELECT/i);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
    expect(params).toEqual([MODEL_READINESS_KEY]);
  });

  it('행이 없으면 빈 준비 상태다 — 워커가 아직 아무것도 안 받았다', async () => {
    expect(await svc(jest.fn().mockResolvedValue({ rows: [] })).get()).toEqual(
      EMPTY_MODEL_READINESS,
    );
  });

  it('DB가 죽어 있어도 던지지 않는다 — 설정 조회가 이 행 때문에 실패하면 안 된다', async () => {
    expect(await svc(jest.fn().mockRejectedValue(new Error('down'))).get()).toEqual(
      EMPTY_MODEL_READINESS,
    );
  });

  it('캐시하지 않는다 — 진행률은 매번 새로 읽어야 한다', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ value: ROW }] });
    const s = svc(query);
    await s.get();
    await s.get();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
