import type {
  Device,
  SummaryModel,
  WhisperModel,
} from "@/features/settings/api/types";
import type { ModelRow, ModelsView } from "../api/types";

/**
 * 프리셋을 고르면 새로 받아야 할 대략 용량 — 프리셋 카드에 붙인다(처리 설정에서 고른 모델이 첫 회의에서야
 * 수 GB를 받다 디스크 부족으로 실패하지 않게, 고르기 전에 보인다).
 *
 * 프리셋이 바꾸는 것은 전사·요약 모델뿐이다(고정 모델·렌즈 모델은 프리셋과 무관). 전사 행은 프리셋의
 * 전사 장치로 고른다 — gpu→mlx, cpu→faster (서버 `models/registry.py`와 같은 규칙).
 *
 * 행이 없거나(다른 백엔드 행은 받아 둔 게 있을 때만 온다) 크기를 모르면 null — 틀린 숫자보다 안 보이는
 * 편이 낫다. 일부만 받은 모델은 남은 만큼만 센다.
 */
export function presetDownloadNeed(
  view: ModelsView,
  preset: {
    whisper_model: WhisperModel;
    devices: { stt: Device };
    summary_model: SummaryModel;
  },
): { bytes: number; exceedsFree: boolean } | null {
  const backend = preset.devices.stt === "gpu" ? "mlx" : "faster";
  const rows = [
    view.models.find(
      (m) =>
        m.role === "stt" &&
        m.name === preset.whisper_model &&
        m.backend === backend,
    ),
    view.models.find(
      (m) => m.role === "summary" && m.name === preset.summary_model,
    ),
  ];
  let bytes = 0;
  for (const r of rows) {
    const need = remaining(r);
    if (need === null) return null;
    bytes += need;
  }
  return {
    bytes,
    exceedsFree: view.freeBytes !== null && bytes > view.freeBytes,
  };
}

function remaining(r: ModelRow | undefined): number | null {
  if (r === undefined || r.installed === "unknown") return null;
  if (r.installed === "yes") return 0;
  if (r.approxBytes === null) return null;
  return r.installed === "partial"
    ? Math.max(0, r.approxBytes - (r.sizeBytes ?? 0))
    : r.approxBytes;
}
