import { readFileSync } from 'fs';
import { join } from 'path';
import { buildModelsView, MODEL_STALL_MS, ModelsViewInput } from '../src/models/models-view';
import { ModelInventory } from '../src/models/model-inventory';
import { EMPTY_MODEL_READINESS, ModelReadinessEntry } from '../src/system/model-readiness';

const NOW = Date.parse('2026-09-25T10:00:10.000Z');
const FIXED = {
  diarization: 'pyannote/speaker-diarization-community-1',
  speaker_embedding: 'speechbrain/spkrec-ecapa-voxceleb',
  search_embedding: 'BAAI/bge-m3',
};
const RESOLVED: ModelInventory['resolved'] = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'].flatMap(
  (name) => [
    { role: 'stt' as const, name, backend: 'mlx' as const, repoId: `mlx/${name}` },
    { role: 'stt' as const, name, backend: 'faster' as const, repoId: `fw/${name}` },
  ],
);

function inv(over: Partial<ModelInventory> = {}): ModelInventory {
  return {
    scannedAt: '2026-09-25T10:00:00.000000Z',
    repos: {},
    resolved: RESOLVED,
    approx: { 'mlx/large-v3': 3083522487 },
    workerLlm: { lensModel: 'mlx-community/Qwen3.5-4B-8bit', summaryFallback: 'mlx-community/Qwen3.5-4B-8bit' },
    ...over,
  };
}

function input(over: Partial<ModelsViewInput> = {}): ModelsViewInput {
  return {
    config: { whisper_model: 'large-v3-turbo', devices: { diarization: 'gpu', stt: 'gpu' }, summary_model: 'mlx-community/Qwen3.5-9B-8bit' },
    fixed: FIXED,
    lensModel: 'mlx-community/Qwen3.5-4B-8bit',
    inventory: inv(),
    readiness: EMPTY_MODEL_READINESS,
    now: NOW,
    ...over,
  };
}

function entry(over: Partial<ModelReadinessEntry>): ModelReadinessEntry {
  return {
    key: 'x', state: 'downloading', bytesDone: 1, bytesTotal: 2, startedAt: null,
    updatedAt: '2026-09-25T10:00:05.000000Z', writer: 'w', attempt: 1, error: null, errorKind: null,
    ...over,
  };
}

const find = (v: ReturnType<typeof buildModelsView>, role: string, name: string, backend: string | null = null) =>
  v.models.find((m) => m.role === role && m.name === name && m.backend === backend);

describe('buildModelsView', () => {
  it('inventory가 없으면 scannedAt null, 모든 행 unknown', () => {
    const v = buildModelsView(input({ inventory: null }));
    expect(v.scannedAt).toBeNull();
    expect(v.totalBytes).toBeNull();
    expect(v.pending).toBe(false);
    expect(v.models.every((m) => m.installed === 'unknown')).toBe(true);
  });

  it('전사: 현재 백엔드 6개 + 다른 백엔드는 받아 둔 것만', () => {
    const v = buildModelsView(input({ inventory: inv({ repos: { 'fw/small': { sizeBytes: 486, complete: true } } }) }));
    const stt = v.models.filter((m) => m.role === 'stt');
    expect(stt.map((m) => `${m.name}:${m.backend}`)).toEqual([
      'tiny:mlx', 'base:mlx', 'small:mlx', 'medium:mlx', 'large-v3:mlx', 'large-v3-turbo:mlx', 'small:faster',
    ]);
    expect(find(v, 'stt', 'small', 'faster')).toMatchObject({ installed: 'yes', sizeBytes: 486, repoId: 'fw/small' });
  });

  it('inUseFor — 전사는 이름과 백엔드가 모두 맞아야 한다', () => {
    const v = buildModelsView(input());
    expect(find(v, 'stt', 'large-v3-turbo', 'mlx')?.inUseFor).toEqual(['stt']);
    const cpu = buildModelsView(input({ config: { whisper_model: 'large-v3-turbo', devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'mlx-community/Qwen3.5-9B-8bit' } }));
    expect(find(cpu, 'stt', 'large-v3-turbo', 'faster')?.inUseFor).toEqual(['stt']);
    expect(find(cpu, 'stt', 'large-v3-turbo', 'mlx')).toBeUndefined(); // 다른 백엔드·안 받음 → 행 없음
  });

  it('inUseFor — 요약·렌즈, 둘이 같으면 한 행에 둘 다', () => {
    const v = buildModelsView(input());
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-9B-8bit')?.inUseFor).toEqual(['summary']);
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-4B-8bit')?.inUseFor).toEqual(['lens']);
    const same = buildModelsView(input({ config: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'gpu' }, summary_model: 'mlx-community/Qwen3.5-4B-8bit' } }));
    expect(find(same, 'summary', 'mlx-community/Qwen3.5-4B-8bit')?.inUseFor).toEqual(['summary', 'lens']);
  });

  it('렌즈 모델이 SUMMARY_MODELS 밖이면 행을 하나 더 만든다 (BE env·worker 값 각각)', () => {
    const v = buildModelsView(input({
      lensModel: 'org/custom-lens',
      inventory: inv({ workerLlm: { lensModel: 'org/worker-lens', summaryFallback: null } }),
    }));
    expect(find(v, 'summary', 'org/custom-lens')).toMatchObject({ inUseFor: ['lens'], repoId: 'org/custom-lens', deletable: false });
    expect(find(v, 'summary', 'org/worker-lens')).toMatchObject({ inUseFor: ['lens'] });
  });

  it('고정 역할: 항상 fixed, 삭제 불가, repoId = 이름', () => {
    const v = buildModelsView(input());
    for (const role of ['diarization', 'speaker_embedding', 'search_embedding'] as const) {
      expect(find(v, role, FIXED[role])).toMatchObject({ inUseFor: ['fixed'], deletable: false, repoId: FIXED[role] });
    }
  });

  it('installed — no / yes / partial, approxBytes', () => {
    const v = buildModelsView(input({ inventory: inv({ repos: {
      'mlx/large-v3-turbo': { sizeBytes: 1600, complete: true },
      'mlx/medium': { sizeBytes: 100, complete: false },
    } }) }));
    expect(find(v, 'stt', 'large-v3-turbo', 'mlx')).toMatchObject({ installed: 'yes', sizeBytes: 1600 });
    expect(find(v, 'stt', 'medium', 'mlx')).toMatchObject({ installed: 'partial', sizeBytes: 100 });
    expect(find(v, 'stt', 'large-v3', 'mlx')).toMatchObject({ installed: 'no', sizeBytes: null, approxBytes: 3083522487 });
  });

  it('deletable — 삭제 가능 역할이고 안 쓸 때만', () => {
    const v = buildModelsView(input());
    expect(find(v, 'stt', 'large-v3-turbo', 'mlx')?.deletable).toBe(false);
    expect(find(v, 'stt', 'small', 'mlx')?.deletable).toBe(true);
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-27B-8bit')?.deletable).toBe(true);
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-4B-8bit')?.deletable).toBe(false); // 렌즈
  });

  it('downloading — 멈춘(120초 넘은) 항목은 받는 중이 아니다', () => {
    const readiness = { updatedAt: null, entries: [
      entry({ key: 'mlx/large-v3', bytesDone: 10, bytesTotal: 30 }),
      entry({ key: 'mlx/medium', updatedAt: new Date(NOW - MODEL_STALL_MS - 1).toISOString() }),
    ] };
    const v = buildModelsView(input({ readiness }));
    expect(find(v, 'stt', 'large-v3', 'mlx')?.downloading).toEqual({ bytesDone: 10, bytesTotal: 30 });
    expect(find(v, 'stt', 'medium', 'mlx')?.downloading).toBeNull();
  });

  it('pending — 받는 중이거나, 카탈로그 repo의 readiness가 scannedAt보다 새로울 때', () => {
    expect(buildModelsView(input()).pending).toBe(false);
    const downloading = { updatedAt: null, entries: [entry({ key: 'mlx/large-v3' })] };
    expect(buildModelsView(input({ readiness: downloading })).pending).toBe(true);
    const readyAfterScan = { updatedAt: null, entries: [entry({ key: 'mlx/large-v3', state: 'ready', updatedAt: '2026-09-25T10:00:03.000000Z' })] };
    expect(buildModelsView(input({ readiness: readyAfterScan })).pending).toBe(true);
    const readyBeforeScan = { updatedAt: null, entries: [entry({ key: 'mlx/large-v3', state: 'ready', updatedAt: '2026-09-25T09:59:00.000000Z' })] };
    expect(buildModelsView(input({ readiness: readyBeforeScan })).pending).toBe(false);
    const foreign = { updatedAt: null, entries: [entry({ key: 'not/in-catalog', state: 'ready', updatedAt: '2026-09-25T10:00:03.000000Z' })] };
    expect(buildModelsView(input({ readiness: foreign })).pending).toBe(false);
  });

  it('totalBytes는 카탈로그 밖 저장소까지 합한다', () => {
    const v = buildModelsView(input({ inventory: inv({ repos: {
      'mlx/large-v3-turbo': { sizeBytes: 1000, complete: true },
      'someone/old-model': { sizeBytes: 500, complete: true },
    } }) }));
    expect(v.totalBytes).toBe(1500);
    expect(v.models.some((m) => m.repoId === 'someone/old-model')).toBe(false);
  });

  it('멈춤 상수는 fe·desktop과 같은 값이다', () => {
    const root = join(__dirname, '..', '..');
    const fe = readFileSync(join(root, 'fe/src/features/settings/lib/model-readiness.ts'), 'utf8');
    const desktop = readFileSync(join(root, 'desktop/src/services/model-readiness.ts'), 'utf8');
    expect(fe).toMatch(/MODEL_STALL_MS = 120_000/);
    expect(desktop).toMatch(/STALL_MS = 120_000/);
    expect(MODEL_STALL_MS).toBe(120_000);
  });
});
