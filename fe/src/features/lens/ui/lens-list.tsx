import * as React from "react";
import { LensItem } from "@/shared/ui/lens-item";
import type { LensListPage } from "../model/types";
import { mapItemView } from "../lib/map-item";

type LensListProps = {
  pages: LensListPage[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onToggle: (id: string, done: boolean) => void;
  onJumpEvidence: (meetingId: string, utteranceId: string) => void;
  speakerName: (id: string | null) => string | null;
  speakerTint: (id: string | null) => number | undefined;
};

export function LensList({
  pages,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onToggle,
  onJumpEvidence,
  speakerName,
  speakerTint,
}: LensListProps) {
  const sentinel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) onLoadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  const items = pages.flatMap((p) => p.items);

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        const v = mapItemView(item);
        const name = speakerName(item.assignee_speaker_id);
        return (
          <LensItem
            key={item.id}
            source={v.source}
            checkable
            done={item.completion_status === "done"}
            onToggle={() =>
              onToggle(item.id, item.completion_status !== "done")
            }
            assignee={name ?? undefined}
            assigneeSpeaker={speakerTint(item.assignee_speaker_id)}
            evidence={v.timecode ?? undefined}
            onJump={
              v.primary
                ? () => onJumpEvidence(item.meeting_id, v.primary!.utteranceId)
                : undefined
            }
          >
            {item.text}
          </LensItem>
        );
      })}
      <div ref={sentinel} aria-hidden className="h-px" />
      {isFetchingNextPage && (
        <p
          role="status"
          aria-busy="true"
          className="py-2 text-center text-sm text-[color:var(--text-muted)]"
        >
          더 불러오는 중…
        </p>
      )}
    </div>
  );
}
