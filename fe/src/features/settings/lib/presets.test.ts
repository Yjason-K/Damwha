import { describe, expect, it } from "vitest";

import {
  PRESET_META,
  PRESET_META_REVISION,
  PRESET_ORDER,
  SUMMARY_MODEL_OPTIONS,
} from "./presets";

describe("PRESET_META — 요약 모델", () => {
  it("프리셋별 요약 모델 매핑이 BE와 일치한다", () => {
    expect(PRESET_META.light.summary_model).toBe(
      "mlx-community/Qwen3.5-4B-8bit",
    );
    expect(PRESET_META.standard.summary_model).toBe(
      "mlx-community/Qwen3.5-9B-8bit",
    );
    expect(PRESET_META.quality.summary_model).toBe(
      "mlx-community/Qwen3.5-27B-8bit",
    );
  });

  it("모든 프리셋의 요약 모델이 선택지 목록 안에 있다", () => {
    const values = SUMMARY_MODEL_OPTIONS.map((o) => o.value);
    for (const name of PRESET_ORDER) {
      expect(values).toContain(PRESET_META[name].summary_model);
    }
  });

  it("BE 프리셋 revision과 맞춘다", () => {
    expect(PRESET_META_REVISION).toBe("2026-08-12.3");
  });
});
