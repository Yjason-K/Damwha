import type { ReactNode } from "react";
import { Link } from "react-router";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
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

/**
 * 회의 목록 카드(스펙 §2.7). 제목과 `회의 열기` 둘 다 상세로 가는 링크이고, 카드
 * 전체는 링크가 아니다 — 링크 안에 링크를 넣지 않기 위해서다.
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
  const meta = [
    m.durationMs != null ? m.dur : null,
    m.participantCount > 0 ? `${m.participantCount}명` : null,
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
    <Card padding="sm" data-testid="meeting-card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link
            to={href}
            className="block truncate rounded-xs text-h3 font-semibold text-foreground no-underline outline-none hover:text-[color:var(--text-link)] focus-visible:[box-shadow:var(--focus-ring)]"
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
          <Button
            asChild
            variant="secondary"
            size="sm"
            className="ml-1.5 no-underline"
          >
            <Link to={href} aria-label={`${m.title} 회의 열기`}>
              회의 열기
              <Icon name="arrowRight" size={14} />
            </Link>
          </Button>
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
