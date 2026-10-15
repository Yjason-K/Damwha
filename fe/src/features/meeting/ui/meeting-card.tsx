import type { ReactNode } from "react";
import { Link } from "react-router";

import { Avatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";

import { dueDateLabel, meetingWhenLabel } from "../lib/meeting-when";
import type { MeetingSummary } from "../model/types";
import { Icon } from "./icons";
import { MeetingStatusBadge } from "./meeting-status-badge";

function PreviewLine({
  icon,
  tone,
  children,
}: {
  icon: "checkCircle" | "alignLeft";
  tone: string;
  children: ReactNode;
}) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-sm text-[color:var(--text-secondary)]">
      <Icon name={icon} size={14} className={tone} />
      <span className="truncate">{children}</span>
    </p>
  );
}

const MAX_AVATARS = 4;

function Participants({
  participants,
}: {
  participants: MeetingSummary["participants"];
}) {
  if (participants.length === 0) return null;
  const shown = participants.slice(0, MAX_AVATARS);
  const rest = participants.length - shown.length;
  return (
    <span
      className="flex items-center"
      aria-label={`참석자: ${participants.map((p) => p.name).join(", ")}`}
      title={participants.map((p) => p.name).join(", ")}
    >
      {shown.map((p, i) => (
        <Avatar
          key={p.id}
          name={p.name}
          speaker={i + 1}
          size="sm"
          unconfirmed={p.provisional}
          className="-ml-1 ring-2 ring-[var(--surface-card)] first:ml-0"
        />
      ))}
      {rest > 0 ? (
        <span className="ml-1 text-xs text-[color:var(--text-muted)]">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 회의 목록 카드(스펙 §2.7). 카드 어디를 눌러도 상세로 간다 — 링크는 제목 하나뿐이고
 * 그 `::after`가 카드 전체를 덮는다(링크 안에 링크를 넣지 않으려고 카드 자체를 링크로
 * 만들지 않는다). 카드마다 반복되던 `회의 열기` 버튼은 UX 리뷰(2026-10-15)에서 뺐다.
 */
export function MeetingCard({
  meeting: m,
  now,
}: {
  meeting: MeetingSummary;
  now?: Date;
}) {
  const href = `/meetings/${m.id}`;
  const firstTag = m.tags[0];
  // participant_count는 클러스터 수라 병합 뒤에도 줄지 않는다 — 아바타와 같은 사람 수를 쓴다.
  const people =
    m.participants.length > 0 ? m.participants.length : m.participantCount;
  const meta = [
    m.durationMs != null ? m.dur : null,
    people > 0 ? `${people}명` : null,
  ];
  const action = m.preview.action;
  const actionLine = action
    ? [
        [
          action.assigneeName,
          action.dueAt ? `${dueDateLabel(action.dueAt)}까지` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        action.text,
      ]
        .filter(Boolean)
        .join(" ")
    : null;
  const secondLine = actionLine ? (
    <PreviewLine icon="checkCircle" tone="text-warning-text">
      {actionLine}
    </PreviewLine>
  ) : m.preview.summary ? (
    <PreviewLine icon="alignLeft" tone="text-[color:var(--text-muted)]">
      {m.preview.summary}
    </PreviewLine>
  ) : null;
  const hasPreview = m.preview.decision != null || secondLine != null;
  const processed = m.status === "done";

  return (
    <Card
      padding="sm"
      interactive
      data-testid="meeting-card"
      className="relative has-[a:focus-visible]:[box-shadow:var(--focus-ring)]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link
            to={href}
            className="block truncate text-h3 font-semibold text-foreground no-underline outline-none after:absolute after:inset-0 after:rounded-md after:content-['']"
          >
            {m.title}
          </Link>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-sm text-[color:var(--text-muted)]">
            {[
              firstTag ? (
                <span key="tag" className="text-[color:var(--accent-text)]">
                  {firstTag.name}
                </span>
              ) : null,
              <span key="when">{meetingWhenLabel(m.startIso, now)}</span>,
              ...meta.map((t, i) => (t ? <span key={i}>{t}</span> : null)),
            ]
              .filter(Boolean)
              .flatMap((el, i) =>
                i === 0
                  ? [el]
                  : [
                      <span key={`sep${i}`} aria-hidden="true">
                        ·
                      </span>,
                      el,
                    ],
              )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Participants participants={m.participants} />
          {processed ? (
            <>
              {m.decisionCount > 0 ? (
                <Badge variant="success">결정 {m.decisionCount}</Badge>
              ) : null}
              {m.actionCount > 0 ? (
                <Badge variant="warning">할 일 {m.actionCount}</Badge>
              ) : null}
              {m.savedCount > 0 ? (
                <Badge
                  variant="outline"
                  icon={<Icon name="bookmark" size={12} />}
                  aria-label={`저장한 발언 ${m.savedCount}`}
                >
                  {m.savedCount}
                </Badge>
              ) : null}
            </>
          ) : (
            <MeetingStatusBadge status={m.status} />
          )}
        </div>
      </div>
      {hasPreview ? (
        <div className="mt-3 flex flex-col gap-1 rounded-sm bg-[var(--surface-sunken)] px-3 py-2">
          {m.preview.decision != null ? (
            <PreviewLine icon="checkCircle" tone="text-success-text">
              {m.preview.decision}
            </PreviewLine>
          ) : null}
          {secondLine}
        </div>
      ) : null}
    </Card>
  );
}
