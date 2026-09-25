import type { ModelRole, SttBackend } from "@damwha/contracts";
import { modelShortLabel } from "@/features/settings/lib/presets";
import type { ModelRow, ModelsView } from "../api/types";
import { formatBytes } from "./format";

/**
 * 모델 카드가 행을 읽는 규칙 (모델 다운로드 관리 스펙 §6). 순수 함수만 둔다.
 *
 * 사용자에게 보이는 이름은 화면에 이미 나간 말만 쓴다 — "화자 식별"은 처리 단계 이름
 * (`pages/meeting.tsx`), "검색 임베딩 모델"은 검색 안내(`app-shell.tsx`). 서비스·라이브러리 이름은
 * 쓰지 않는다.
 */
export const ROLE_TITLES: Record<ModelRole, string> = {
  stt: "전사 모델",
  summary: "요약 모델",
  diarization: "화자 분리 모델",
  speaker_embedding: "화자 식별 모델",
  search_embedding: "검색 임베딩 모델",
};

const FIXED_SHORT: Record<string, string> = {
  diarization: "화자 분리",
  speaker_embedding: "화자 식별",
  search_embedding: "검색 임베딩",
};

const isFixed = (r: ModelRow) => r.inUseFor.includes("fixed");

export function rowLabel(r: ModelRow, current: SttBackend | null): string {
  if (isFixed(r)) return ROLE_TITLES[r.role];
  const base = modelShortLabel(r.role, r.name);
  if (r.role === "stt" && current !== null && r.backend !== current) {
    return `${base} · ${r.backend === "mlx" ? "GPU용" : "CPU용"}`;
  }
  return base;
}

export function statusText(r: ModelRow): string {
  if (r.downloading) {
    const { bytesDone, bytesTotal } = r.downloading;
    if (bytesTotal <= 0) return "받는 중";
    const pct = Math.floor((bytesDone / bytesTotal) * 100);
    return `받는 중 ${pct}% · ${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}`;
  }
  switch (r.installed) {
    case "yes":
      return `받음 · ${formatBytes(r.sizeBytes ?? 0)}`;
    case "partial":
      return `일부만 받음 · ${formatBytes(r.sizeBytes ?? 0)}`;
    case "no":
      return r.approxBytes ? `안 받음 · 약 ${formatBytes(r.approxBytes)}` : "안 받음";
    default:
      return "확인 중";
  }
}

export function isVisibleByDefault(r: ModelRow): boolean {
  return (
    r.inUseFor.length > 0 ||
    r.installed === "yes" ||
    r.installed === "partial" ||
    r.downloading !== null ||
    // 고정 역할(화자 분리·화자 식별·검색 임베딩)은 inUseFor 태그와 무관하게 늘 보인다 —
    // 이 셋은 항상 필요한 모델이라 "확인 중"이어도 숨기지 않는다.
    (r.role !== "stt" && r.role !== "summary")
  );
}

export function currentSttBackend(models: ModelRow[]): SttBackend | null {
  return models.find((m) => m.role === "stt" && m.inUseFor.includes("stt"))?.backend ?? null;
}

export interface SummaryLine {
  label: string;
  value: string;
  status: string;
}

/** 요약 줄의 상태 — 안 받은 사용 중 모델은 "처음 회의를 처리할 때 받아요"를 덧붙인다. */
function inUseStatus(r: ModelRow): string {
  if (r.installed === "no" && !r.downloading) {
    const approx = r.approxBytes ? ` (약 ${formatBytes(r.approxBytes)})` : "";
    return `안 받음 · 처음 회의를 처리할 때 받아요${approx}`;
  }
  return statusText(r);
}

export function summaryLines(view: ModelsView): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const stt = view.models.find((m) => m.role === "stt" && m.inUseFor.includes("stt"));
  if (stt) {
    lines.push({
      label: "전사",
      value: `${modelShortLabel("stt", stt.name)} · ${stt.backend === "mlx" ? "GPU" : "CPU"}`,
      status: inUseStatus(stt),
    });
  }
  for (const r of view.models.filter((m) => m.role === "summary")) {
    const s = r.inUseFor.includes("summary");
    const l = r.inUseFor.includes("lens");
    if (!s && !l) continue;
    lines.push({
      label: s && l ? "요약·렌즈 추출" : s ? "요약" : "렌즈 추출",
      value: modelShortLabel("summary", r.name),
      status: inUseStatus(r),
    });
  }
  // "요약"이 "렌즈 추출"보다 먼저 오게 — 같은 우선순위 안에서는 카탈로그 순서.
  const rank = (label: string) => (label.startsWith("요약") ? 0 : 1);
  const head = lines.slice(0, stt ? 1 : 0);
  const rest = lines.slice(stt ? 1 : 0).sort((a, b) => rank(a.label) - rank(b.label));
  const fixed = view.models.filter(isFixed);
  if (fixed.length > 0) {
    const missing = fixed.filter((r) => r.installed !== "yes");
    rest.push({
      label: "기본",
      value: fixed.map((r) => FIXED_SHORT[r.role] ?? ROLE_TITLES[r.role]).join(" · "),
      status:
        missing.length === 0
          ? `모두 받음 · ${formatBytes(fixed.reduce((s, r) => s + (r.sizeBytes ?? 0), 0))}`
          : missing.map((r) => `${ROLE_TITLES[r.role]} ${statusText(r)}`).join(" · "),
    });
  }
  return [...head, ...rest];
}
