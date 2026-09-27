import { fromInventoryRow } from '../src/models/model-inventory';

const ROW = {
  scanned_at: '2026-09-25T10:00:00.000000Z',
  repos: { 'mlx-community/whisper-large-v3-turbo': { size_bytes: 1612345678, complete: true } },
  resolved: [
    { role: 'stt', name: 'small', backend: 'faster', repo_id: 'Systran/faster-whisper-small' },
  ],
  approx: { 'Systran/faster-whisper-small': 486212372 },
  worker_llm: { lens_model: 'mlx-community/Qwen3.5-4B-8bit', summary_fallback: 'mlx-community/Qwen3.5-4B-8bit' },
};

describe('fromInventoryRow', () => {
  it('worker가 쓴 행을 camelCase로 편다', () => {
    expect(fromInventoryRow(ROW)).toEqual({
      scannedAt: '2026-09-25T10:00:00.000000Z',
      repos: { 'mlx-community/whisper-large-v3-turbo': { sizeBytes: 1612345678, complete: true } },
      resolved: [{ role: 'stt', name: 'small', backend: 'faster', repoId: 'Systran/faster-whisper-small' }],
      approx: { 'Systran/faster-whisper-small': 486212372 },
      workerLlm: { lensModel: 'mlx-community/Qwen3.5-4B-8bit', summaryFallback: 'mlx-community/Qwen3.5-4B-8bit' },
      freeBytes: null,
    });
  });

  it.each([null, 3, 'x', [], {}, { repos: {} }])('읽을 수 없는 행 %p → null (던지지 않는다)', (raw) => {
    expect(fromInventoryRow(raw)).toBeNull();
  });

  it('옛/새 worker의 필드 누락·추가를 견딘다', () => {
    const v = fromInventoryRow({
      scanned_at: 't',
      repos: { 'a/b': { size_bytes: 'big', complete: true }, 'c/d': 5, 'e/f': { size_bytes: 1, complete: false } },
      resolved: [{ role: 'stt' }, 'junk'],
      extra_future_field: 1,
    });
    expect(v).toEqual({
      scannedAt: 't',
      repos: { 'e/f': { sizeBytes: 1, complete: false } },
      resolved: [],
      approx: {},
      workerLlm: { lensModel: null, summaryFallback: null },
      freeBytes: null,
    });
  });

  it('free_bytes를 싣고, 없거나 숫자가 아니면 null', () => {
    expect(fromInventoryRow({ scanned_at: 't', free_bytes: 42 })?.freeBytes).toBe(42);
    expect(fromInventoryRow({ scanned_at: 't' })?.freeBytes).toBeNull();
    expect(fromInventoryRow({ scanned_at: 't', free_bytes: 'x' })?.freeBytes).toBeNull();
  });
});
