import * as React from "react";

import { formatClock } from "@/features/meeting/api/mappers";
import { Icon } from "@/features/meeting/ui/icons";
import { useSpeakers } from "@/features/speaker/api/speakers";
import { MeetingGroupHeader } from "@/shared/ui/meeting-group-header";
import { Utterance } from "@/shared/ui/utterance";
import type { SavedUtterance } from "../api/types";
import {
  useRemoveSavedUtterance,
  useSavedUtterances,
} from "../api/saved-utterances";

type MeetingGroup = {
  meeting: SavedUtterance["meeting"];
  items: SavedUtterance[];
};

/**
 * 목록은 서버에서 회의 우선으로 정렬되어 오므로 연속 구간이 곧 회의 그룹이다.
 * 구간이 페이지 경계에 걸려도 다음 페이지 첫 항목이 같은 회의면 그대로 이어진다.
 */
function groupByMeeting(items: SavedUtterance[]): MeetingGroup[] {
  const groups: MeetingGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.meeting.id === item.meeting.id) last.items.push(item);
    else groups.push({ meeting: item.meeting, items: [item] });
  }
  return groups;
}

export function SavedUtteranceDashboard() {
  const list = useSavedUtterances();
  const remove = useRemoveSavedUtterance();
  const speakers = useSpeakers();
  const sentinel = React.useRef<HTMLDivElement>(null);

  const items = React.useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );
  const groups = React.useMemo(() => groupByMeeting(items), [items]);

  // 화자 tint는 회의 상세와 같은 규칙 — 화자 목록 순번(1..n)에 색을 맞춘다.
  const speakerTint = React.useMemo(() => {
    const index = new Map<string, number>();
    (speakers.data ?? []).forEach((s, i) => index.set(s.id, i + 1));
    return (id: string | null) => (id ? index.get(id) : undefined);
  }, [speakers.data]);

  React.useEffect(() => {
    const target = sentinel.current;
    if (!target || !list.hasNextPage || list.isFetchingNextPage) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) list.fetchNextPage();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [list.fetchNextPage, list.hasNextPage, list.isFetchingNextPage]);

  return (
    <main className="col-start-2 flex min-w-0 flex-col overflow-hidden bg-[var(--surface-app)]">
      <header className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-7 pt-[18px] pb-3.5">
        <div className="flex items-center gap-[9px] text-[color:var(--text-secondary)]">
          <Icon name="bookmark" size={19} />
          <h1 className="text-h2 font-semibold tracking-[-0.01em] text-foreground">
            저장한 발언
          </h1>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <div className="mx-auto flex max-w-[820px] flex-col">
          {list.isLoading && (
            <p
              role="status"
              aria-busy="true"
              className="py-8 text-center text-sm text-[color:var(--text-muted)]"
            >
              불러오는 중…
            </p>
          )}
          {list.isError && (
            <p
              role="alert"
              className="py-8 text-center text-sm text-[color:var(--text-muted)]"
            >
              목록을 불러오지 못했어요.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => list.refetch()}
              >
                다시 시도
              </button>
            </p>
          )}
          {list.isSuccess && items.length === 0 && (
            <p className="py-8 text-center text-sm text-[color:var(--text-muted)]">
              나중에 다시 보고 싶은 발언을 저장해 보세요.
            </p>
          )}
          {groups.map((group, index) => {
            // 마지막 그룹은 아직 다 받지 않았을 수 있어 개수를 말할 수 없다.
            const settled = index < groups.length - 1 || !list.hasNextPage;
            return (
              <section
                key={group.meeting.id}
                className={
                  index > 0
                    ? "mt-5 border-t border-[color:var(--border-subtle)] pt-4"
                    : undefined
                }
              >
                <MeetingGroupHeader
                  meetingId={group.meeting.id}
                  title={group.meeting.title}
                  recordedAt={group.meeting.recordedAt}
                  count={settled ? group.items.length : undefined}
                />
                <div className="flex flex-col gap-px rounded-md bg-[var(--surface-card)] py-1">
                  {group.items.map((item) => (
                    <Utterance
                      key={item.id}
                      className="scroll-mt-14"
                      time={formatClock(item.startMs)}
                      speaker={speakerTint(item.speakerId)}
                      name={item.speakerName ?? "알 수 없음"}
                      saved
                      savedBadge={false}
                      savePending={remove.isPending}
                      onSaveToggle={() =>
                        item.utteranceId && remove.mutate(item.utteranceId)
                      }
                      to={
                        item.utteranceId
                          ? `/meetings/${item.meeting.id}?u=${item.utteranceId}`
                          : undefined
                      }
                    >
                      {item.text}
                    </Utterance>
                  ))}
                </div>
              </section>
            );
          })}
          <div ref={sentinel} aria-hidden className="h-px" />
          {list.isFetchingNextPage && (
            <p
              role="status"
              aria-busy="true"
              className="py-2 text-center text-sm text-[color:var(--text-muted)]"
            >
              더 불러오는 중…
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
