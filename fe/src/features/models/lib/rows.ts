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

/**
 * 아직 이 Mac에 없는 모델인가(받는 중·대기도 아님) — 그 상태 문구("약 3.1 GB")를 흐리게 그려, 받아 둔 모델의
 * 용량("1.6 GB")과 한눈에 가른다. 받은 모델은 단어 없이 용량만 보이므로 이 구분이 둘을 나누는 유일한 표시다.
 */
export function awaitingDownload(r: ModelRow): boolean {
  return r.installed === "no" && r.downloading === null && !hasActiveJob(r);
}

/**
 * 행의 상태 문구. 받아 둔 모델은 단어 없이 **용량만** 보인다 — "받음" 같은 상태어를 매 줄 되풀이하지 않고,
 * 단어는 예외 상태(일부만 받음·받는 중·대기·지우는 중·확인 중)에만 남긴다. 안 받은 모델은 받기 전 추정치라
 * "약 X"이고(크기를 모르면 "안 받음"), 화면이 `awaitingDownload`로 흐리게 그린다.
 */
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
      return formatBytes(r.sizeBytes ?? 0);
    case "partial":
      return `일부만 받음 · ${formatBytes(r.sizeBytes ?? 0)}`;
    case "no":
      return r.approxBytes ? `약 ${formatBytes(r.approxBytes)}` : "안 받음";
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

/** 요약 줄의 상태 — 안 받은 모델은 "처음 쓸 때 받아요"를 덧붙인다(옆에 "미리 받기"가 붙는다). */
function inUseStatus(r: ModelRow): string {
  // (D2 최종 리뷰) 이미 받기 job이 대기·진행 중이면 statusText의 job 문구("받기 대기 중"/"받는 중")를
  // 그대로 보인다 — 안 그러면 이미 받고 있다는 사실을 감추고 아직 시작 안 한 것처럼 읽힌다.
  if (awaitingDownload(r)) {
    return r.approxBytes
      ? `약 ${formatBytes(r.approxBytes)} · 처음 쓸 때 받아요`
      : "안 받음 · 처음 쓸 때 받아요";
  }
  return statusText(r);
}

/**
 * 처리 방식 섹션이 넘기는 "고르는 중인" 전사·요약 모델. 주면 저장된 값(`inUseFor`) 대신 이것으로 줄을
 * 만든다 — 프리셋을 누르는 순간, 저장하기 전에도 결과와 받음 상태가 보이게.
 */
export interface ModelPick {
  whisper_model: string;
  devices: { stt: "gpu" | "cpu" };
  summary_model: string;
}

/**
 * 목록에 없는 고른 모델의 자리 — 다른 백엔드 전사 행은 받아 둔 게 있을 때만 오므로, 없으면 안 받은 것이다.
 * "미리 받기"가 논리 키만으로 동작하므로 이 행으로도 받을 수 있다.
 */
function missingRow(
  view: ModelsView,
  key: Pick<ModelRow, "role" | "name" | "backend">,
): ModelRow {
  return {
    ...key,
    repoId: null,
    inUseFor: [],
    installed: view.scannedAt === null ? "unknown" : "no",
    sizeBytes: null,
    approxBytes: null,
    downloading: null,
    deletable: false,
    job: null,
  };
}

export function summaryLines(view: ModelsView, pick?: ModelPick): SummaryLine[] {
  const lines: SummaryLine[] = [];
  let stt: ModelRow | undefined;
  if (pick) {
    const backend = pick.devices.stt === "gpu" ? "mlx" : "faster";
    stt =
      view.models.find((m) => m.role === "stt" && m.name === pick.whisper_model && m.backend === backend) ??
      missingRow(view, { role: "stt", name: pick.whisper_model, backend });
  } else {
    stt = view.models.find((m) => m.role === "stt" && m.inUseFor.includes("stt"));
  }
  if (stt) {
    lines.push({
      label: "전사",
      value: `${modelShortLabel("stt", stt.name)} · ${stt.backend === "mlx" ? "GPU" : "CPU"}`,
      status: inUseStatus(stt),
      row: stt,
    });
  }
  // 요약은 고른 값(pick) 또는 저장된 값, 렌즈 추출은 늘 서버가 정한 값(inUseFor "lens" — 설정이 바꾸지 않는다).
  const usesSummary = (m: ModelRow) =>
    pick ? m.name === pick.summary_model : m.inUseFor.includes("summary");
  const summaryRows = view.models.filter((m) => m.role === "summary");
  if (pick && !summaryRows.some(usesSummary)) {
    summaryRows.push(missingRow(view, { role: "summary", name: pick.summary_model, backend: null }));
  }
  for (const r of summaryRows) {
    const s = usesSummary(r);
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
          ? formatBytes(fixed.reduce((s, r) => s + (r.sizeBytes ?? 0), 0))
          : // 빠진 것만 풀어 쓴다 — 여기서는 "약 89 MB"만으로는 무엇이 빠졌는지 안 읽히므로 "안 받음"을 적는다.
            missing
              .map((r) => `${ROLE_TITLES[r.role]} ${awaitingDownload(r) ? "안 받음" : statusText(r)}`)
              .join(" · "),
    });
  }
  return [...head, ...rest];
}
