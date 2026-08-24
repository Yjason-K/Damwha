import * as React from "react";
import { useNavigate } from "react-router";

import { formatClock } from "@/features/meeting/api/mappers";
import { Icon } from "@/features/meeting/ui/icons";
import { Button } from "@/shared/ui/button";
import { useRemoveSavedUtterance, useSavedUtterances } from "../api/saved-utterances";

export function SavedUtteranceDashboard() {
  const navigate = useNavigate();
  const list = useSavedUtterances();
  const remove = useRemoveSavedUtterance();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const sentinel = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const target = sentinel.current;
    if (!target || !list.hasNextPage || list.isFetchingNextPage) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) list.fetchNextPage(); });
    observer.observe(target);
    return () => observer.disconnect();
  }, [list.fetchNextPage, list.hasNextPage, list.isFetchingNextPage]);

  return <main className="col-start-2 flex min-w-0 flex-col overflow-hidden bg-[var(--surface-app)]">
    <header className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-7 pt-[18px] pb-3.5">
      <div className="flex items-center gap-[9px] text-[color:var(--text-secondary)]"><Icon name="bookmark" size={19} /><h1 className="text-h2 font-semibold tracking-[-0.01em] text-foreground">저장한 발언</h1></div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5"><div className="mx-auto flex max-w-[760px] flex-col gap-3">
      {list.isLoading && <p role="status" className="py-8 text-center text-sm text-[color:var(--text-muted)]">불러오는 중…</p>}
      {list.isError && <p role="alert" className="py-8 text-center text-sm text-[color:var(--text-muted)]">목록을 불러오지 못했어요. <button type="button" className="underline" onClick={() => list.refetch()}>다시 시도</button></p>}
      {list.isSuccess && items.length === 0 && <p className="py-8 text-center text-sm text-[color:var(--text-muted)]">나중에 다시 보고 싶은 발언을 저장해 보세요.</p>}
      {items.map((item) => <article key={item.id} className="rounded-md border border-border bg-card p-4 [box-shadow:var(--shadow-xs)]">
        <p className="text-xs font-semibold text-[color:var(--text-secondary)]">{item.meeting.title ?? "제목 없는 회의"}</p>
        <p className="mt-1 text-xs text-[color:var(--text-muted)]">{[item.speakerName, formatClock(item.startMs)].filter(Boolean).join(" · ")}</p>
        <blockquote className="mt-3 border-l-2 border-[color:var(--accent-6)] pl-3 text-read text-foreground">{item.text}</blockquote>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={!item.utteranceId} onClick={() => item.utteranceId && navigate(`/meetings/${item.meeting.id}?u=${item.utteranceId}`)}>원문으로 이동</Button>
          <Button variant="ghost" size="sm" disabled={!item.utteranceId || remove.isPending} onClick={() => item.utteranceId && remove.mutate(item.utteranceId)}>저장 해제</Button>
        </div>
      </article>)}
      <div ref={sentinel} aria-hidden className="h-px" />
    </div></div>
  </main>;
}
