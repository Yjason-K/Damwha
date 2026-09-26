import { useState } from "react";
import type { ModelRole } from "@damwha/contracts";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { useModels } from "../api/models";
import type { ModelRow } from "../api/types";
import { formatBytes } from "../lib/format";
import {
  ROLE_TITLES,
  awaitingDownload,
  currentSttBackend,
  isVisibleByDefault,
  rowLabel,
  statusText,
} from "../lib/rows";
import { ModelRowActions } from "./model-row-actions";

const GROUPS: { title: string; roles: ModelRole[] }[] = [
  { title: ROLE_TITLES.stt, roles: ["stt"] },
  { title: ROLE_TITLES.summary, roles: ["summary"] },
  {
    title: "기본 모델 · 항상 사용",
    roles: ["diarization", "speaker_embedding", "search_embedding"],
  },
];

/**
 * 설정 › "모델" 카드 (모델 다운로드 관리 스펙 §6) — 이 Mac의 보관함: 받아 둔 모델, 합계, 받기·취소·삭제
 * (`ModelRowActions`). "지금 쓰는 모델" 요약은 처리 방식 섹션의 `ModelsInUse`가 맡는다(스펙 §11,
 * 2026-09-26) — 고르는 곳과 결과가 한 섹션에 있어야 저장 전에도 무엇이 쓰일지 보인다.
 */
export function ModelsCard() {
  const { data, isError } = useModels();
  const [expanded, setExpanded] = useState(false);

  return (
    <section aria-labelledby="settings-models">
      <Card className="flex flex-col gap-4">
        <header className="flex items-baseline justify-between gap-3">
          <h2
            id="settings-models"
            className="text-h2 font-semibold text-foreground"
          >
            모델
          </h2>
          {data?.totalBytes != null && data.scannedAt !== null && (
            <span className="text-sm text-[color:var(--text-muted)]">
              받은 모델 합계 {formatBytes(data.totalBytes)}
            </span>
          )}
        </header>
        <p className="text-sm text-[color:var(--text-muted)]">
          이 Mac에 받아 둔 모델이에요. 처음 쓸 때 받고, 받은 뒤에는 남아요. 필요
          없는 전사·요약 모델은 지울 수 있어요.
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
            <ModelList
              models={data.models}
              freeBytes={data.freeBytes}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
            />
          </>
        )}
      </Card>
    </section>
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
                    <span
                      className={
                        awaitingDownload(m)
                          ? "text-[color:var(--text-muted)]"
                          : "text-[color:var(--text-secondary)]"
                      }
                    >
                      {statusText(m)}
                    </span>
                    <ModelRowActions
                      row={m}
                      freeBytes={freeBytes}
                      label={rowLabel(m, current)}
                    />
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
