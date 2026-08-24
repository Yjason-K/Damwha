import { useLensExtractionStatus, useRetryExtraction } from "../api/lenses";

export function LensExtractionBanner() {
  const status = useLensExtractionStatus();
  const retry = useRetryExtraction();
  const data = status.data;
  if (!data || (data.running === 0 && data.failed.length === 0)) return null;

  return (
    <div data-testid="banner-root" className="flex flex-col gap-1.5">
      {data.running > 0 && (
        <div className="rounded-sm bg-[var(--accent-1)] px-3 py-2 text-sm text-[color:var(--accent-text)]">
          렌즈 추출 {data.running}건 진행 중…
        </div>
      )}
      {data.failed.map((f) => (
        <div
          key={f.meeting_id}
          className="flex items-center justify-between rounded-sm bg-[var(--amber-bg)] px-3 py-2 text-sm text-[color:var(--amber-text)]"
        >
          <span>추출 실패: {f.title ?? "제목 없는 회의"}</span>
          <button
            type="button"
            onClick={() => retry.mutate(f.meeting_id)}
            disabled={retry.isPending}
            className="rounded-xs border border-current px-2 py-0.5 text-2xs font-medium disabled:opacity-50"
          >
            재시도
          </button>
        </div>
      ))}
    </div>
  );
}
