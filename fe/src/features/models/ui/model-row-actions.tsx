import { useState } from "react";
import { isApiError } from "@/shared/api/client";
import { Button } from "@/shared/ui/button";
import { useDiarizationGate } from "@/features/hf-token/ui/hf-token-gate";
import { HfFailureAction } from "@/features/hf-token/ui/hf-failure-action";
import { useCancelModelJob, useDownloadModel } from "../api/models";
import type { ModelRow } from "../api/types";
import { conflictText, exceedsFreeSpace, jobErrorText, rowAction } from "../lib/actions";
import { formatBytes } from "../lib/format";
import { DeleteModelDialog } from "./delete-model-dialog";

/** 서버 오류를 code로 고른 문구로 바꾼다 — 자유 문구를 짓지 않는다. */
function toConflictMessage(e: unknown): string {
  return isApiError(e) ? (conflictText(e.code) ?? e.message) : "요청하지 못했어요.";
}

/** 이 행이 지금 어떤 상태에서의 결과였는지 — 오래된 오류가 다른 상태에서 되살아나지 않게. */
function rowSig(row: ModelRow): string {
  return `${row.installed}:${row.job?.id ?? ""}`;
}

/**
 * 행 하나에 대한 오류 한 줄 — 그 오류가 난 시점의 행 상태({@link rowSig})와 함께 담아 둔다.
 * 렌더마다 지금 행의 sig와 비교해서, 그 사이 행 상태가 바뀌었으면(다른 성공·다른 job으로) 화면에
 * 내지 않는다 — 지우는 effect 없이 렌더 중 파생으로 처리한다. 그래도 "새 동작을 시작했다"는
 * 신호는 즉시 와야 하므로(다음 결과가 오기 전에 이전 오류가 남아 있으면 안 된다) `clear()`를 각
 * 동작 시작 시점에도 부른다.
 */
function useConflictFor(row: ModelRow) {
  const sig = rowSig(row);
  const [state, setState] = useState<{ msg: string; sig: string } | null>(null);
  return {
    conflict: state !== null && state.sig === sig ? state.msg : null,
    report: (e: unknown) => setState({ msg: toConflictMessage(e), sig }),
    clear: () => setState(null),
  };
}

/**
 * 받기 시작 공통 로직 (스펙 §6.4) — 화자 분리 모델은 `useDiarizationGate().run()`을 거친다. 토큰이
 * 없으면 게이트가 다이얼로그를 띄우고 여기서는 요청을 보내지 않는다 — 토큰을 넣은 뒤 자동으로
 * 이어 받지 않는다(기존 게이트와 같게, 사람이 "받기"를 다시 누른다).
 */
function useDownloadStart(
  row: ModelRow,
  conflict: { report: (e: unknown) => void; clear: () => void },
) {
  const download = useDownloadModel();
  const gate = useDiarizationGate();
  const key = { role: row.role, name: row.name, backend: row.backend };

  const start = () => {
    conflict.clear();
    const go = () =>
      download.mutate(key, { onSuccess: conflict.clear, onError: conflict.report });
    if (row.role === "diarization") gate.run(go);
    else go();
  };

  return { start, isPending: download.isPending, locked: gate.locked };
}

/** 요약(§6.1)의 안 받은 줄에 붙는 "미리 받기" — 행 동작과 같은 시작 로직(게이트 포함)을 쓴다. */
export function DownloadNowButton({ row, label }: { row: ModelRow; label: string }) {
  const { conflict, report, clear } = useConflictFor(row);
  const { start, isPending, locked } = useDownloadStart(row, { report, clear });
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
 *
 * 받기·취소·삭제는 한 행에서 배타적(`rowAction`이 한 번에 하나만 고른다)이라 오류 한 줄을 셋이
 * 공유한다({@link useConflictFor}) — 어느 동작을 시작하거나(삭제는 확인 다이얼로그를 여는 시점)
 * 성공하면 즉시 지운다.
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
  const { conflict, report, clear } = useConflictFor(row);
  const { start: startDownload, isPending: downloadPending, locked } = useDownloadStart(row, {
    report,
    clear,
  });
  const cancel = useCancelModelJob();
  const [confirming, setConfirming] = useState(false);
  const action = rowAction(row);
  const err = jobErrorText(row);
  const job = row.job;

  const openConfirm = () => {
    clear();
    setConfirming(true);
  };

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
            onClick={() => {
              clear();
              cancel.mutate(job.id, { onSuccess: clear, onError: report });
            }}
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
            onClick={openConfirm}
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
          {err.accept && <HfFailureAction action="accept" />}
        </p>
      )}
      {conflict && <p className="text-xs text-[color:var(--red-text)]">{conflict}</p>}
      <DeleteModelDialog
        open={confirming}
        onOpenChange={setConfirming}
        row={row}
        label={label}
        onError={report}
        onSuccess={clear}
      />
    </div>
  );
}
