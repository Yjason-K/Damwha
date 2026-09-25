import { useState } from "react";
import { isApiError } from "@/shared/api/client";
import { Button } from "@/shared/ui/button";
import { useDiarizationGate } from "@/features/hf-token/ui/hf-token-gate";
import { sendHfTokenAction } from "@/features/hf-token/lib/use-hf-token";
import { useCancelModelJob, useDownloadModel } from "../api/models";
import type { ModelRow } from "../api/types";
import { conflictText, exceedsFreeSpace, jobErrorText, rowAction } from "../lib/actions";
import { formatBytes } from "../lib/format";
import { DeleteModelDialog } from "./delete-model-dialog";

/** 서버 오류를 code로 고른 문구로 바꾼다 — 자유 문구를 짓지 않는다. */
function toConflictMessage(e: unknown): string {
  return isApiError(e) ? (conflictText(e.code) ?? e.message) : "요청하지 못했어요.";
}

/**
 * 받기 시작 공통 로직 (스펙 §6.4) — 화자 분리 모델은 `useDiarizationGate().run()`을 거친다. 토큰이
 * 없으면 게이트가 다이얼로그를 띄우고 여기서는 요청을 보내지 않는다 — 토큰을 넣은 뒤 자동으로
 * 이어 받지 않는다(기존 게이트와 같게, 사람이 "받기"를 다시 누른다).
 */
function useDownloadStart(row: ModelRow) {
  const download = useDownloadModel();
  const gate = useDiarizationGate();
  const [conflict, setConflict] = useState<string | null>(null);
  const key = { role: row.role, name: row.name, backend: row.backend };

  const start = () => {
    setConflict(null);
    const go = () => download.mutate(key, { onError: (e) => setConflict(toConflictMessage(e)) });
    if (row.role === "diarization") gate.run(go);
    else go();
  };

  return { start, isPending: download.isPending, locked: gate.locked, conflict };
}

/** 요약(§6.1)의 안 받은 줄에 붙는 "미리 받기" — 행 동작과 같은 시작 로직(게이트 포함)을 쓴다. */
export function DownloadNowButton({ row, label }: { row: ModelRow; label: string }) {
  const { start, isPending, locked, conflict } = useDownloadStart(row);
  return (
    <span className="flex items-center gap-2">
      {conflict && <span className="text-xs text-[color:var(--red-text)]">{conflict}</span>}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        aria-label={`${label} 미리 받기`}
        disabled={isPending || locked}
        onClick={start}
      >
        미리 받기
      </Button>
    </span>
  );
}

/**
 * 모델 행의 동작 (모델 다운로드 관리 스펙 §6.4). 받기는 확인 없이, 삭제는 확인 뒤, 화자 분리 모델
 * 받기는 토큰 게이트를 거친다 — 토큰을 넣은 뒤 자동으로 이어 받지 않는다(기존 게이트와 같게).
 */
export function ModelRowActions({
  row,
  freeBytes,
  label,
}: {
  row: ModelRow;
  freeBytes: number | null;
  label: string;
}) {
  const {
    start: startDownload,
    isPending: downloadPending,
    locked,
    conflict: downloadConflict,
  } = useDownloadStart(row);
  const cancel = useCancelModelJob();
  const [confirming, setConfirming] = useState(false);
  const [otherConflict, setOtherConflict] = useState<string | null>(null);
  const action = rowAction(row);
  const err = jobErrorText(row);
  const job = row.job;
  const conflict = downloadConflict ?? otherConflict;

  const onOtherError = (e: unknown) => setOtherConflict(toConflictMessage(e));

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {(action.kind === "download" || action.kind === "redownload") && (
          <>
            {exceedsFreeSpace(row, freeBytes) && freeBytes !== null && (
              <span className="text-xs text-[color:var(--red-text)]">
                남은 용량({formatBytes(freeBytes)})보다 커요
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label={`${label} 받기`}
              disabled={downloadPending || locked}
              onClick={startDownload}
            >
              {action.kind === "download" ? "받기" : "다시 받기"}
            </Button>
          </>
        )}
        {action.kind === "cancel" && job !== null && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${label} 받기 취소`}
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(job.id, { onError: onOtherError })}
          >
            취소
          </Button>
        )}
        {action.kind === "delete" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${label} 삭제`}
            onClick={() => setConfirming(true)}
          >
            삭제
          </Button>
        )}
        {action.kind === null && action.reason && (
          <span className="text-xs text-[color:var(--text-faint)]">{action.reason}</span>
        )}
      </div>
      {err && (
        <p className="flex items-center gap-2 text-xs text-[color:var(--red-text)]">
          {err.text}
          {err.accept && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => sendHfTokenAction({ kind: "open", link: "accept" })}
            >
              사용 조건 페이지 열기
            </Button>
          )}
        </p>
      )}
      {conflict && <p className="text-xs text-[color:var(--red-text)]">{conflict}</p>}
      <DeleteModelDialog
        open={confirming}
        onOpenChange={setConfirming}
        row={row}
        label={label}
        onError={onOtherError}
      />
    </div>
  );
}
