import type * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { IconButton } from "@/shared/ui/icon-button";
import { Kbd } from "@/shared/ui/kbd";
import { SearchField } from "@/shared/ui/search-field";
import { SidebarItem } from "@/shared/ui/sidebar-item";
import { cn } from "@/shared/lib/utils";

import {
  ME,
  MEETING_ORDER,
  MEETINGS,
  meetingSub,
  type LensKind,
  type MeetingFilter,
} from "../model/data";
import { Icon } from "./icons";

/**
 * LeftNav — browse-first rail: logo, ⌘K search, new-meeting CTA, nav,
 * filter pills, meeting list, profile. Ported from the Damwha Design System
 * UI kit (`timbre_app/LeftNav.jsx`).
 */

function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-2.5 pt-4 pb-1.5 text-2xs font-semibold tracking-[var(--tracking-wide)] text-[color:var(--text-faint)] uppercase">
      <span>{children}</span>
      {action}
    </div>
  );
}

function NewMeetingItem({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-[9px] rounded-sm border border-[color:var(--accent-6)] bg-[var(--accent-1)] px-2.5 py-2 text-left text-sm font-semibold text-[color:var(--accent-text)] outline-none transition-colors duration-[80ms] hover:bg-[var(--accent-2)] focus-visible:[box-shadow:var(--focus-ring)]"
    >
      <Icon name="plus" size={16} />
      <span className="flex-1">새 회의 기록하기</span>
      <Kbd>N</Kbd>
    </button>
  );
}

const FILTER_ITEMS: [MeetingFilter, string][] = [
  ["all", "전체"],
  ["mine", "내 참여"],
  ["fav", "즐겨찾기"],
];

function FilterPills({
  value,
  onChange,
}: {
  value: MeetingFilter;
  onChange: (f: MeetingFilter) => void;
}) {
  return (
    <div className="flex gap-1.5 px-1">
      {FILTER_ITEMS.map(([k, label]) => {
        const active = value === k;
        return (
          <button
            key={k}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(k)}
            className={cn(
              "cursor-pointer rounded-full px-[11px] py-[5px] text-xs font-medium outline-none transition-colors duration-[80ms] focus-visible:[box-shadow:var(--focus-ring)]",
              active
                ? "bg-[var(--accent-solid)] text-white"
                : "text-[color:var(--text-secondary)] hover:bg-[var(--surface-hover)]",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ProfileCard() {
  return (
    <div className="mx-1.5 mt-2 mb-1 flex items-center gap-[9px] rounded-md border border-border bg-card px-2.5 py-2">
      <Avatar name="김영재" speaker={1} size="md" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-2xs text-[color:var(--text-faint)]">나의 공간</div>
        <div className="truncate text-sm font-semibold text-foreground">
          김영재
        </div>
      </div>
      <Icon
        name="chevsUpDown"
        size={15}
        className="text-[color:var(--text-faint)]"
      />
      <IconButton label="설정" size="sm">
        <Icon name="settings" size={16} />
      </IconButton>
    </div>
  );
}

type LeftNavProps = {
  currentId: string;
  view: "meeting" | "lens";
  filter: MeetingFilter;
  onFilter: (f: MeetingFilter) => void;
  onSelectMeeting: (id: string) => void;
  onSelectLens: (lens: LensKind) => void;
  onOpenSearch: () => void;
};

export function LeftNav({
  currentId,
  view,
  filter,
  onFilter,
  onSelectMeeting,
  onSelectLens,
  onOpenSearch,
}: LeftNavProps) {
  const meetings = MEETING_ORDER.map((mid) => MEETINGS[mid]).filter((m) => {
    if (filter === "mine") return m.attendees.includes(ME);
    if (filter === "fav") return !!m.fav;
    return true;
  });

  return (
    <nav
      aria-label="주 탐색"
      className="flex w-[var(--rail-nav)] shrink-0 flex-col overflow-hidden border-r border-border bg-[var(--surface-panel)]"
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-2.5">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="block"
        >
          <path
            d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
            stroke="var(--text-primary)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="8.5" cy="10" r="1.25" fill="var(--text-primary)" />
          <circle cx="12" cy="10" r="1.25" fill="var(--text-primary)" />
          <circle cx="15.5" cy="10" r="1.25" fill="var(--text-primary)" />
        </svg>
        <span className="text-h2 font-semibold tracking-[-0.03em] text-foreground">
          Damwha
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-0.5 pb-2">
        <div className="mb-3 px-0.5">
          <SearchField
            asButton
            aria-label="검색 (명령 팔레트 열기)"
            onClick={onOpenSearch}
            shortcut={<Kbd keys={["⌘", "K"]} />}
          />
        </div>
        <NewMeetingItem />

        <div className="mt-3.5 flex flex-col gap-0.5">
          <SidebarItem
            icon={<Icon name="inbox" size={16} />}
            label="받은 회의"
            count={2}
          />
          <SidebarItem
            icon={<Icon name="bookmark" size={16} />}
            label="저장한 발언"
          />
          <SidebarItem
            icon={<Icon name="listChecks" size={16} />}
            label="모든 회의"
            active={view === "lens"}
            onClick={() => onSelectLens("action")}
          />
        </div>

        <SectionLabel>필터</SectionLabel>
        <FilterPills value={filter} onChange={onFilter} />

        <SectionLabel
          action={
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-[3px] rounded-xs font-medium tracking-normal normal-case outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            >
              최신순 <Icon name="chevsUpDown" size={12} />
            </button>
          }
        >
          회의 목록
        </SectionLabel>
        <ul className="flex flex-col gap-0.5" aria-label="회의 목록">
          {meetings.map((m) => (
            <li key={m.id}>
              <SidebarItem
                label={m.title}
                sub={meetingSub(m)}
                meta={m.dur}
                active={view === "meeting" && currentId === m.id}
                onClick={() => onSelectMeeting(m.id)}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-[color:var(--border-subtle)]">
        <ProfileCard />
      </div>
    </nav>
  );
}
