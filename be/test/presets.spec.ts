import { PRESET_REVISION, resolvePreset } from '../src/settings/presets';
import { SUMMARY_MODELS } from '../src/contracts/model-catalog';

describe('resolvePreset — 요약 모델', () => {
  it('프리셋별 요약 모델 매핑', () => {
    expect(resolvePreset('light', 'ko').summary_model).toBe('qwen3.5:4b-mlx');
    expect(resolvePreset('standard', 'ko').summary_model).toBe('qwen3.5:8b-mlx');
    expect(resolvePreset('quality', 'ko').summary_model).toBe('qwen3.5:14b-mlx');
  });

  it('모든 프리셋의 요약 모델은 카탈로그 안에 있다', () => {
    for (const name of ['light', 'standard', 'quality'] as const) {
      expect(SUMMARY_MODELS).toContain(resolvePreset(name, 'ko').summary_model);
    }
  });

  it('프리셋 정의가 바뀌었으므로 revision을 올린다', () => {
    expect(PRESET_REVISION).toBe('2026-08-12.1');
  });
});
