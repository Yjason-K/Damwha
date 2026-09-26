import { useModels } from "../api/models";
import { rowAction } from "../lib/actions";
import {
  awaitingDownload,
  currentSttBackend,
  rowLabel,
  summaryLines,
  type ModelPick,
} from "../lib/rows";
import { DownloadNowButton } from "./model-row-actions";

/**
 * 처리 방식 섹션의 "이 설정으로 쓰는 모델" — 고르는 중인 전사·요약 모델(`pick`)과 늘 쓰는 모델(렌즈 추출·
 * 기본 모델)이 무엇이고 받아 두었는지를 보인다. 저장 전에도 폼 값을 따라 바뀐다. 안 받은 줄에는 "미리 받기".
 *
 * 모델 상태를 아직 모르면(불러오는 중·실패·스캔 전) 그리지 않는다 — 그 안내는 아래 모델 섹션이 한다.
 */
export function ModelsInUse({ pick }: { pick: ModelPick }) {
  const { data } = useModels();
  if (!data || data.scannedAt === null) return null;
  const current = currentSttBackend(data.models);

  return (
    <section
      aria-label="이 설정으로 쓰는 모델"
      className="flex flex-col gap-2 rounded-md border border-[color:var(--border-subtle)] p-3"
    >
      <span className="text-sm font-medium text-[color:var(--text-secondary)]">
        이 설정으로 쓰는 모델
      </span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {summaryLines(data, pick).map((l) => {
          const canDownloadNow =
            l.row !== undefined && rowAction(l.row).kind === "download";
          return (
            <div key={`${l.label}:${l.value}`} className="contents">
              <dt className="text-[color:var(--text-muted)]">{l.label}</dt>
              <dd className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-foreground">
                <span>{l.value}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      l.row && awaitingDownload(l.row)
                        ? "text-[color:var(--text-muted)]"
                        : "text-[color:var(--text-secondary)]"
                    }
                  >
                    {l.status}
                  </span>
                  {canDownloadNow && l.row && (
                    <DownloadNowButton
                      row={l.row}
                      label={rowLabel(l.row, current)}
                    />
                  )}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
