import { useState } from "react";
import type { ModelRole } from "@damwha/contracts";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { useModels } from "../api/models";
import type { ModelRow } from "../api/types";
import { rowAction } from "../lib/actions";
import { formatBytes } from "../lib/format";
import {
  ROLE_TITLES,
  currentSttBackend,
  isVisibleByDefault,
  rowLabel,
  statusText,
  summaryLines,
} from "../lib/rows";
import { DownloadNowButton, ModelRowActions } from "./model-row-actions";

const GROUPS: { title: string; roles: ModelRole[] }[] = [
  { title: ROLE_TITLES.stt, roles: ["stt"] },
  { title: ROLE_TITLES.summary, roles: ["summary"] },
  {
    title: "기본 모델 · 항상 사용",
    roles: ["diarization", "speaker_embedding", "search_embedding"],
  },
];

/**
 * 설정 › "모델" 카드 (모델 다운로드 관리 스펙 §6). 목록 행에는 `ModelRowActions`(받기·취소·삭제),
 * 요약의 안 받은 줄에는 `DownloadNowButton`("미리 받기")이 붙는다(D2, §6.4).
 */
export function ModelsCard() {
  const { data, isError } = useModels();
  const [expanded, setExpanded] = useState(false);
  const current = data ? currentSttBackend(data.models) : null;

  return (
    <Card className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">모델</h2>
        {data?.totalBytes != null && data.scannedAt !== null && (
          <span className="text-sm text-[color:var(--text-muted)]">
            받은 모델 합계 {formatBytes(data.totalBytes)}
          </span>
        )}
      </header>
      <p className="text-sm text-[color:var(--text-muted)]">
        회의를 처리할 때 쓰는 모델이에요. 처음 쓸 때 받고, 받은 뒤에는 이 Mac에
        남아요.
      </p>
      {isError ? (
        <p className="text-sm text-[color:var(--red-text)]">
          모델 상태를 불러오지 못했어요.
        </p>
      ) : !data ? (
        <p role="status" className="text-sm text-[color:var(--text-muted)]">
          모델 상태를 불러오는 중…
        </p>
      ) : data.scannedAt === null ? (
        <p role="status" className="text-sm text-[color:var(--text-muted)]">
          모델 상태를 아직 확인하지 못했어요. 작업 처리기가 준비되면 보여요.
        </p>
      ) : (
        <>
          <section
            aria-label="지금 설정에서 쓰는 모델"
            className="flex flex-col gap-2 rounded-md border border-[color:var(--border-subtle)] p-3"
          >
            <span className="text-sm font-medium text-[color:var(--text-secondary)]">
              지금 설정에서 쓰는 모델
            </span>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {summaryLines(data).map((l) => {
                const canDownloadNow = l.row !== undefined && rowAction(l.row).kind === "download";
                return (
                  <div key={`${l.label}:${l.value}`} className="contents">
                    <dt className="text-[color:var(--text-muted)]">{l.label}</dt>
                    <dd className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-foreground">
                      <span>{l.value}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[color:var(--text-secondary)]">
                          {l.status}
                        </span>
                        {canDownloadNow && l.row && (
                          <DownloadNowButton row={l.row} label={rowLabel(l.row, current)} />
                        )}
                      </span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
          <ModelList
            models={data.models}
            freeBytes={data.freeBytes}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        </>
      )}
    </Card>
  );
}

function ModelList({
  models,
  freeBytes,
  expanded,
  onToggle,
}: {
  models: ModelRow[];
  freeBytes: number | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const current = currentSttBackend(models);
  const hiddenCount = models.filter((m) => !isVisibleByDefault(m)).length;
  return (
    <section aria-label="받아 둔 모델" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">
          받아 둔 모델
        </span>
        {(hiddenCount > 0 || expanded) && (
          <button
            type="button"
            onClick={onToggle}
            className="text-sm font-medium text-[color:var(--accent-text)] outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            {expanded ? "접기" : "모든 모델 보기"}
          </button>
        )}
      </div>
      {GROUPS.map((g) => {
        const rows = models.filter(
          (m) =>
            g.roles.includes(m.role) && (expanded || isVisibleByDefault(m)),
        );
        if (rows.length === 0) return null;
        return (
          <div key={g.title} className="flex flex-col gap-1">
            <span className="text-xs text-[color:var(--text-muted)]">
              {g.title}
            </span>
            <ul className="flex flex-col gap-1">
              {rows.map((m) => (
                <li
                  key={`${m.role}:${m.name}:${m.backend ?? ""}`}
                  className="flex flex-wrap items-center justify-between gap-x-3 text-sm"
                >
                  <span className="flex items-center gap-2 text-foreground">
                    {rowLabel(m, current)}
                    {m.inUseFor.length > 0 && !m.inUseFor.includes("fixed") && (
                      <Badge variant="accent">사용 중</Badge>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-[color:var(--text-secondary)]">
                      {statusText(m)}
                    </span>
                    <ModelRowActions row={m} freeBytes={freeBytes} label={rowLabel(m, current)} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
