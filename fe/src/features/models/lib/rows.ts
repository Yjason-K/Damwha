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

/** (D2 최종 리뷰) 이 행에 대기·진행 중인 받기·삭제 job이 있는가 — `lib/actions.ts`의 `active`와 같은 판정. */
const hasActiveJob = (r: ModelRow) => r.job !== null && (r.job.status === "queued" || r.job.status === "running");

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
  // (D2 최종 리뷰) downloading이 없어도(예: CPU 백엔드는 진행률을 안 준다) job이 대기·진행
  // 중이면 그 사실을 문구로 남긴다 — 안 그러면 "안 받음"/"확인 중"에 그대로 굳어 보인다.
  if (r.job !== null && hasActiveJob(r)) {
    if (r.job.type === "delete_model") return "지우는 중";
    return r.job.status === "queued" ? "받기 대기 중" : "받는 중";
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
    // (D2 최종 리뷰) 대기·진행 중인 받기·삭제 job이 있으면 "모든 모델 보기"를 접어도 이 행은
    // 계속 보인다 — 안 그러면 진행 중인 작업이 화면에서 사라진 것처럼 보인다.
    hasActiveJob(r) ||
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
  /** (D2) 전사·요약·렌즈 줄이 대응하는 행 — 안 받았으면 카드가 여기 "미리 받기"를 붙인다. */
  row?: ModelRow;
}

/** 요약 줄의 상태 — 안 받은 사용 중 모델은 "처음 회의를 처리할 때 받아요"를 덧붙인다. */
function inUseStatus(r: ModelRow): string {
  // (D2 최종 리뷰) 이미 받기 job이 대기·진행 중이면 "처음 회의를 처리할 때 받아요"가 아니라
  // statusText의 job 문구("받기 대기 중"/"받는 중")를 그대로 보인다 — 안 그러면 이미 받고
  // 있다는 사실을 감추고 아직 시작 안 한 것처럼 읽힌다.
  if (r.installed === "no" && !r.downloading && !hasActiveJob(r)) {
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
      row: stt,
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
      row: r,
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
