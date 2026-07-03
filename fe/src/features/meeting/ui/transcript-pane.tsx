import * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";
import { Utterance } from "@/shared/ui/utterance";

import { SPEAKERS, type Meeting } from "../model/data";
import { Icon } from "./icons";

/**
 * TranscriptPane — center pane: meta header, attendee pills, speaker-verify
 * banner, AI-suggestion banner, utterances, bottom toolbar. Ported from the
 * Damwha Design System UI kit (`timbre_app/TranscriptPane.jsx`).
 */

function MicMini() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="2.5" width="4" height="7" rx="2" />
      <path d="M4.5 8a3.5 3.5 0 0 0 7 0M8 11.5v2" />
    </svg>
  );
}

function AttendeePill({ speaker, name }: { speaker: number; name: string }) {
  const k = ((speaker - 1) % 8) + 1;
  return (
    <span
      className="inline-flex items-center gap-[5px] rounded-full py-0.5 pr-[9px] pl-[3px] text-xs font-semibold"
      style={{
        background: `var(--spk-${k}-bg)`,
        color: `var(--spk-${k}-text)`,
      }}
    >
      <span
        className="inline-flex size-4 items-center justify-center rounded-full text-white [&_svg]:size-[9px]"
        style={{ background: `var(--spk-${k}-solid)` }}
      >
        <MicMini />
      </span>
      {name}
    </span>
  );
}

function MetaItem({
  icon,
  children,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-[5px] whitespace-nowrap">
      <Icon name={icon} size={14} />
      {children}
    </span>
  );
}

function AiBanner({
  meeting,
  onDetail,
  onAck,
}: {
  meeting: Meeting;
  onDetail: () => void;
  onAck: () => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-md border border-[color:var(--accent-6)] bg-[var(--accent-1)] px-3.5 py-3">
      <Badge variant="accent" icon={<Icon name="sparkles" size={12} />}>
        AI 제안 {meeting.aiCount}개
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-foreground">
          {meeting.aiHeadline}
        </div>
        <div className="mt-0.5 text-xs text-[color:var(--text-secondary)]">
          {meeting.aiDetail}
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        iconLeft={<Icon name="command" size={14} />}
        onClick={onDetail}
      >
        자세히 보기
      </Button>
      <Button
        variant="primary"
        size="sm"
        iconLeft={<Icon name="check" size={14} strokeWidth={2.4} />}
        onClick={onAck}
      >
        요약 확인
      </Button>
    </div>
  );
}

function VerifyBanner({
  pending,
  onConfirm,
  onReject,
}: {
  pending: number[];
  onConfirm: () => void;
  onReject: () => void;
}) {
  if (pending.length === 0) return null;
  const sp = SPEAKERS[pending[0]];
  const k = ((sp.spk - 1) % 8) + 1;
  return (
    <div
      className="mb-3.5 flex items-center gap-3 rounded-md border border-dashed bg-[var(--gray-0)] px-3.5 py-[11px]"
      style={{ borderColor: `var(--spk-${k}-solid)` }}
    >
      <Avatar name={sp.name} speaker={sp.spk} unconfirmed size="md" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">
          이 목소리,{" "}
          <span style={{ color: `var(--spk-${k}-text)` }}>{sp.name}</span>{" "}
          맞나요?
        </div>
        <div className="mt-px text-xs text-[color:var(--text-secondary)]">
          성문으로 자동 연결했어요 · 남은 확인 {pending.length}명
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onReject}>
        다른 사람
      </Button>
      <Button
        variant="primary"
        size="sm"
        iconLeft={<Icon name="check" size={14} strokeWidth={2.4} />}
        onClick={onConfirm}
      >
        맞아요
      </Button>
    </div>
  );
}

type TranscriptPaneProps = {
  meeting: Meeting;
  activeId: string;
  onJump: (uid: string) => void;
  pending: number[];
  onConfirm: () => void;
  onReject: () => void;
  aiAcked: boolean;
  onAckAi: () => void;
  onShowSummary: () => void;
  onOpenSearch: () => void;
};

export function TranscriptPane({
  meeting,
  activeId,
  onJump,
  pending,
  onConfirm,
  onReject,
  aiAcked,
  onAckAi,
  onShowSummary,
  onOpenSearch,
}: TranscriptPaneProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Utterance-jump: reveal the active utterance when it changes. On a jump
  // within the same meeting (⌘K·원문 보기), also move focus to the target so
  // keyboard/SR users land where the jump went — skipped on first render and
  // on meeting switches. setTimeout lets Radix's dialog focus-return run first.
  const prevRef = React.useRef<{ mid: string; uid: string } | null>(null);
  React.useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-uid="${activeId}"]`,
    );
    const prev = prevRef.current;
    prevRef.current = { mid: meeting.id, uid: activeId };
    if (!el) return;
    el.scrollIntoView?.({ block: "nearest" });
    if (prev && prev.mid === meeting.id && prev.uid !== activeId) {
      const t = window.setTimeout(() => el.focus({ preventScroll: true }), 0);
      return () => window.clearTimeout(t);
    }
  }, [activeId, meeting.id]);

  const scrollToEnd = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-card)]">
      {/* header: title + actions, meta, attendees */}
      <div className="shrink-0 px-7 py-3.5">
        <div className="mb-[11px] flex items-center gap-2">
          <h1 className="min-w-0 truncate text-h1 font-semibold tracking-[-0.02em] text-foreground">
            {meeting.subOverride ?? meeting.title}
          </h1>
          <IconButton label="별표" size="sm" pressed={meeting.fav}>
            <Icon name="star" size={17} />
          </IconButton>
          <div className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="jump" size={14} />}
          >
            공유
          </Button>
          <IconButton label="더보기" size="sm">
            <Icon name="more" size={16} />
          </IconButton>
          <IconButton label="저장" size="sm">
            <Icon name="bookmark" size={16} />
          </IconButton>
        </div>
        <div className="flex items-center gap-3.5 text-xs text-[color:var(--text-muted)]">
          <MetaItem icon="calendar">{meeting.timeRange}</MetaItem>
          <MetaItem icon="clock">{meeting.dur}</MetaItem>
          <MetaItem icon="users">참석자 {meeting.attendees.length}명</MetaItem>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-[7px]">
          {meeting.attendees.map((a) => (
            <AttendeePill
              key={a}
              speaker={SPEAKERS[a].spk}
              name={SPEAKERS[a].name}
            />
          ))}
          <button
            type="button"
            aria-label="참석자 추가"
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-dashed border-[color:var(--border-strong)] text-[color:var(--text-muted)] outline-none transition-colors hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      </div>

      {/* scroll body */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-6"
      >
        <VerifyBanner
          pending={pending}
          onConfirm={onConfirm}
          onReject={onReject}
        />
        {!aiAcked && (
          <AiBanner
            meeting={meeting}
            onDetail={onShowSummary}
            onAck={onAckAi}
          />
        )}
        <div className="flex flex-col gap-px" role="log" aria-label="회의 전사">
          {meeting.utterances.map((u) => (
            <Utterance
              key={u.id}
              data-uid={u.id}
              tabIndex={-1}
              speaker={SPEAKERS[u.spk].spk}
              name={SPEAKERS[u.spk].name}
              time={u.t}
              active={activeId === u.id}
              quoted={u.quoted}
              onJump={() => onJump(u.id)}
            >
              {u.text}
            </Utterance>
          ))}
        </div>
      </div>

      {/* bottom toolbar */}
      <div className="flex shrink-0 items-center justify-between bg-[var(--surface-card)] px-7 py-2">
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Icon name="search" size={14} />}
          onClick={onOpenSearch}
        >
          발언 검색
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconRight={<Icon name="chevDown" size={14} />}
          onClick={scrollToEnd}
        >
          전체 스크롤
        </Button>
      </div>
    </main>
  );
}
