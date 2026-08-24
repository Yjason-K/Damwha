import { resolveProcessingConfig, ProcessingOverrideSchema } from '../src/settings/resolve-processing';
import { resolvePreset } from '../src/settings/presets';

const global_ = resolvePreset('standard', 'ko');

describe('resolveProcessingConfig', () => {
  it('override 없음 → 전역 그대로', () => {
    expect(resolveProcessingConfig(global_, undefined, true)).toEqual(global_);
  });
  it('preset override → 통째 대체 (이름 유지)', () => {
    const r = resolveProcessingConfig(global_, { preset: 'quality' }, true);
    expect(r.preset).toBe('quality');
    expect(r.whisper_model).toBe('large-v3');
  });
  it('개별 필드 override → 얕은 병합 + preset custom + revision null (spec §5)', () => {
    const r = resolveProcessingConfig(global_, { devices: { stt: 'cpu' } }, true);
    expect(r.devices).toEqual({ diarization: 'gpu', stt: 'cpu' });
    expect(r.whisper_model).toBe('large-v3-turbo'); // 전역 유지
    expect(r.preset).toBe('custom');
    expect(r.preset_revision).toBeNull();
  });
  it('preset + 개별 필드 혼합 → preset resolve 후 병합, 결과는 custom', () => {
    const r = resolveProcessingConfig(global_, { preset: 'light', whisper_model: 'medium' }, true);
    expect(r.whisper_model).toBe('medium');
    expect(r.devices.stt).toBe('cpu'); // light 유래
    expect(r.preset).toBe('custom');
  });
  it('gpu 비적격 + 결과에 gpu → BadRequestException', () => {
    expect(() => resolveProcessingConfig(global_, undefined, false)).toThrow(/gpu/);
  });
  it('스키마: 알 수 없는 필드 거부', () => {
    expect(ProcessingOverrideSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
  it('스키마: 빈 devices 객체 거부 — 값 없이 custom 전환만 일으키는 입력 차단', () => {
    expect(ProcessingOverrideSchema.safeParse({ devices: {} }).success).toBe(false);
  });

  it('summary_model만 override → 병합 + preset custom (spec §5)', () => {
    const r = resolveProcessingConfig(global_, { summary_model: 'mlx-community/Qwen3.5-27B-8bit' }, true);
    expect(r.summary_model).toBe('mlx-community/Qwen3.5-27B-8bit');
    expect(r.whisper_model).toBe('large-v3-turbo'); // 전역 유지
    expect(r.preset).toBe('custom');
    expect(r.preset_revision).toBeNull();
  });

  it('preset override는 그 프리셋의 요약 모델을 통째로 가져온다', () => {
    const r = resolveProcessingConfig(global_, { preset: 'quality' }, true);
    expect(r.summary_model).toBe('mlx-community/Qwen3.5-27B-8bit');
    expect(r.preset).toBe('quality');
  });

  it('preset + summary_model 혼합 → 프리셋 resolve 후 요약 모델만 덮어씀, 결과 custom', () => {
    const r = resolveProcessingConfig(global_, { preset: 'light', summary_model: 'mlx-community/Qwen3.5-27B-8bit' }, true);
    expect(r.whisper_model).toBe('small');              // light 유래
    expect(r.summary_model).toBe('mlx-community/Qwen3.5-27B-8bit');    // 개별 override
    expect(r.preset).toBe('custom');
  });

  it('스키마: 목록 밖 summary_model 거부', () => {
    expect(ProcessingOverrideSchema.safeParse({ summary_model: 'gpt-9' }).success).toBe(false);
  });
});
