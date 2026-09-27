import { describe, expect, test } from "vitest";
import type { ModelRow, ModelsView } from "../api/types";
import { presetDownloadNeed } from "./preset-need";

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt",
    name: "large-v3",
    backend: "mlx",
    repoId: "r",
    inUseFor: [],
    installed: "yes",
    sizeBytes: 3_000_000_000,
    approxBytes: 3_083_522_487,
    downloading: null,
    deletable: true,
    job: null,
    ...over,
  };
}

function view(models: ModelRow[], freeBytes: number | null = null): ModelsView {
  return { scannedAt: "t", totalBytes: 1, pending: false, models, freeBytes };
}

const QUALITY = {
  whisper_model: "large-v3" as const,
  devices: { diarization: "gpu" as const, stt: "gpu" as const },
  summary_model: "mlx-community/Qwen3.5-27B-8bit" as const,
};
const Q27 = "mlx-community/Qwen3.5-27B-8bit";

describe("presetDownloadNeed", () => {
  test("둘 다 받아 두었으면 0", () => {
    const v = view([
      row({}),
      row({ role: "summary", name: Q27, backend: null }),
    ]);
    expect(presetDownloadNeed(v, QUALITY)).toEqual({
      bytes: 0,
      exceedsFree: false,
    });
  });

  test("안 받은 모델의 대략 용량을 더하고, 남은 용량과 비교한다", () => {
    const v = view(
      [
        row({ installed: "no", sizeBytes: null }),
        row({
          role: "summary",
          name: Q27,
          backend: null,
          installed: "no",
          sizeBytes: null,
          approxBytes: 29_528_168_817,
        }),
      ],
      15_000_000_000,
    );
    expect(presetDownloadNeed(v, QUALITY)).toEqual({
      bytes: 3_083_522_487 + 29_528_168_817,
      exceedsFree: true,
    });
  });

  test("일부만 받은 모델은 남은 만큼만 센다", () => {
    const v = view([
      row({}),
      row({
        role: "summary",
        name: Q27,
        backend: null,
        installed: "partial",
        sizeBytes: 9_528_168_817,
        approxBytes: 29_528_168_817,
      }),
    ]);
    expect(presetDownloadNeed(v, QUALITY)?.bytes).toBe(20_000_000_000);
  });

  test("전사 백엔드는 프리셋의 전사 장치로 고른다 (cpu → faster 행)", () => {
    const light = {
      whisper_model: "small" as const,
      devices: { diarization: "gpu" as const, stt: "cpu" as const },
      summary_model: "mlx-community/Qwen3.5-4B-8bit" as const,
    };
    const v = view([
      row({ name: "small", backend: "mlx", installed: "yes" }),
      row({
        name: "small",
        backend: "faster",
        installed: "no",
        sizeBytes: null,
        approxBytes: 484_000_000,
      }),
      row({
        role: "summary",
        name: "mlx-community/Qwen3.5-4B-8bit",
        backend: null,
      }),
    ]);
    expect(presetDownloadNeed(v, light)?.bytes).toBe(484_000_000);
  });

  test("행이 없거나 크기를 모르면 null — 틀린 숫자보다 안 보이는 게 낫다", () => {
    expect(
      presetDownloadNeed(
        view([row({ role: "summary", name: Q27, backend: null })]),
        QUALITY,
      ),
    ).toBeNull();
    const unknownSize = view([
      row({ installed: "no", sizeBytes: null, approxBytes: null }),
      row({ role: "summary", name: Q27, backend: null }),
    ]);
    expect(presetDownloadNeed(unknownSize, QUALITY)).toBeNull();
    const unknownInstall = view([
      row({ installed: "unknown" }),
      row({ role: "summary", name: Q27, backend: null }),
    ]);
    expect(presetDownloadNeed(unknownInstall, QUALITY)).toBeNull();
  });
});
