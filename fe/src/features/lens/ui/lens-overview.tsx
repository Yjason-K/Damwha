import * as React from "react";
import { Link } from "react-router";

import { Avatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { Icon } from "@/features/meeting/ui/icons";
import { useSpeakers } from "@/features/speaker/api/speakers";

import { useLensOverview } from "../api/lenses";
import { dueDay } from "../lib/due-day";
import { mapItemView } from "../lib/map-item";
import type { LensKind, LensWireItem } from "../model/types";

const linkClass =
  "rounded-xs outline-none focus-visible:[box-shadow:var(--focus-ring)]";

function itemHref(item: LensWireItem): string {
  const primary = mapItemView(item).primary;
  return primary
    ? `/meetings/${item.meeting_id}?u=${primary.utteranceId}`
    : `/meetings/${item.meeting_id}`;
}

function OverviewCard({
  kind,
  folderId,
  title,
  tone,
  emptyText,
  renderItem,
}: {
  kind: LensKind;
  folderId?: string;
  title: string;
  tone: "success" | "warning";
  emptyText: string;
  renderItem: (item: LensWireItem) => React.ReactNode;
}) {
  const query = useLensOverview(kind, folderId);
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;

  return (
    <Card padding="sm" aria-label={title} role="region">
      <div className="flex items-center gap-2">
        <Icon
          name="checkCircle"
          size={16}
          className={
            tone === "success" ? "text-success-text" : "text-warning-text"
          }
        />
        <h2 className="text-h3 font-semibold text-foreground">{title}</h2>
        {query.isSuccess ? (
          <Badge variant={tone} aria-label={`${title} ${total}건`}>
            {total}건
          </Badge>
        ) : null}
        <Link
          to={`/lenses/${kind}`}
          className={`${linkClass} ml-auto inline-flex items-center gap-1 text-sm text-[color:var(--text-muted)] no-underline hover:text-foreground`}
        >
          모두 보기
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {query.isPending ? (
          <p
            role="status"
            aria-busy="true"
            className="py-3 text-sm text-[color:var(--text-muted)]"
          >
            불러오는 중…
          </p>
        ) : query.isError ? (
          <p className="py-3 text-sm text-[color:var(--text-muted)]">
            불러오지 못했어요.
          </p>
        ) : items.length === 0 ? (
          <p className="py-3 text-sm text-[color:var(--text-muted)]">
            {emptyText}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>{renderItem(item)}</li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

const rowClass =
  "block rounded-sm border border-[color:var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5 transition-[border-color] duration-[var(--dur-instant)] ease-[var(--ease-standard)] hover:border-border";

function DecisionRow({ item }: { item: LensWireItem }) {
  const v = mapItemView(item);
  return (
    <div className={rowClass}>
      <p className="text-base font-medium text-pretty text-foreground">
        &ldquo;{item.text}&rdquo;
      </p>
      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-[color:var(--text-muted)]">
        <Link
          to={`/meetings/${item.meeting_id}`}
          className={`${linkClass} truncate text-[color:var(--text-muted)] no-underline hover:text-foreground`}
        >
          {item.meeting.title ?? "제목 없는 회의"}
        </Link>
        {v.primary ? (
          <>
            <span aria-hidden="true">·</span>
            <Link
              to={itemHref(item)}
              aria-label={`회의에서 보기 ${v.timecode}`}
              className={`${linkClass} shrink-0 font-mono tracking-[var(--tracking-mono)] text-[color:var(--text-link)] no-underline hover:underline`}
            >
              {v.timecode}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}

function ActionRow({
  item,
  assignee,
  tint,
  now,
}: {
  item: LensWireItem;
  assignee: string | null;
  tint: number | undefined;
  now: Date;
}) {
  const due = item.due_at ? dueDay(item.due_at, now) : null;
  return (
    <Link
      to={itemHref(item)}
      className={`${rowClass} ${linkClass} no-underline`}
    >
      <span className="flex items-center gap-2">
        {assignee ? (
          <>
            <Avatar size="xs" name={assignee} speaker={tint} />
            <span className="truncate text-base font-medium text-foreground">
              {assignee}
            </span>
          </>
        ) : (
          <span className="truncate text-base font-medium text-foreground">
            {item.text}
          </span>
        )}
        {due ? (
          <Badge
            variant={due.urgent ? "danger" : "warning"}
            className="ml-auto font-mono tracking-[var(--tracking-mono)]"
          >
            {due.label}
          </Badge>
        ) : null}
      </span>
      {assignee ? (
        <span className="mt-1 block truncate text-sm text-[color:var(--text-secondary)]">
          {item.text}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * 회의 목록(전체·폴더) 위의 `최근 결정` / `진행 중인 할 일` 요약. 폴더 화면에서는 그
 * 폴더의 회의만 센다(`folder_id`). 행은 근거 발화로 점프하고, `모두 보기`는 전역 렌즈
 * 대시보드로 간다.
 */
export function LensOverview({ folderId }: { folderId?: string }) {
  const speakers = useSpeakers();
  const now = new Date();
  const speakerOf = (id: string | null) => {
    const list = speakers.data ?? [];
    const index = id ? list.findIndex((s) => s.id === id) : -1;
    return index < 0
      ? { name: null, tint: undefined }
      : { name: list[index].name, tint: index + 1 };
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      <OverviewCard
        kind="decision"
        folderId={folderId}
        title="최근 결정"
        tone="success"
        emptyText="아직 결정이 없어요."
        renderItem={(item) => <DecisionRow item={item} />}
      />
      <OverviewCard
        kind="action"
        folderId={folderId}
        title="진행 중인 할 일"
        tone="warning"
        emptyText="진행 중인 할 일이 없어요."
        renderItem={(item) => {
          const who = speakerOf(item.assignee_speaker_id);
          return (
            <ActionRow
              item={item}
              assignee={who.name}
              tint={who.tint}
              now={now}
            />
          );
        }}
      />
    </div>
  );
}
