import * as React from "react";
import { Link, useMatch, useNavigate, useParams } from "react-router";

import { Badge } from "@/shared/ui/badge";
import { BrandMark } from "@/shared/ui/brand-mark";
import { Kbd } from "@/shared/ui/kbd";
import { SearchField } from "@/shared/ui/search-field";
import { SidebarItem } from "@/shared/ui/sidebar-item";
import { cn } from "@/shared/lib/utils";
import { env } from "@/shared/config/env";

import { ThemeMenu } from "@/features/theme/ui/theme-menu";

import { useFolders } from "../api/folders";
import { useMeetings } from "../api/meetings";
import { useTags, type TagSummary } from "../api/tags";
import type { MeetingFilter, MeetingStatus } from "../model/types";
import { FolderSection } from "./folder-section";
import { Icon } from "./icons";
import { NewMeetingDialog } from "./new-meeting-dialog";
import { SectionLabel } from "./section-label";

const TourLaunchButton = React.lazy(() =>
  import("@/features/demo/ui/tour-launch-button").then((m) => ({
    default: m.TourLaunchButton,
  })),
);

/**
 * LeftNav — browse-first rail: logo, ⌘K search, new-meeting CTA, nav,
 * folders, filter pills, meeting list, profile. Ported from the Damwha Design
 * System UI kit (`timbre_app/LeftNav.jsx`).
 */

function NewMeetingItem({
  onClick,
  disabled,
}: {
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-tour="new-meeting"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full cursor-pointer items-center gap-[9px] rounded-sm border border-[color:var(--accent-6)] bg-[var(--accent-1)] px-2.5 py-2 text-left text-sm font-semibold text-[color:var(--accent-text)] outline-none transition-colors duration-[80ms] hover:bg-[var(--accent-2)] focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-default disabled:opacity-60"
    >
      <Icon name="plus" size={16} />
      <span className="flex-1">새 회의 기록하기</span>
      <Kbd>N</Kbd>
    </button>
  );
}

const FILTER_ITEMS: [MeetingFilter, string][] = [
  ["all", "전체"],
  ["fav", "즐겨찾기"],
];

/** 처리 중/실패 회의에 붙는 상태 뱃지 (done은 없음). */
function statusBadge(status: MeetingStatus): React.ReactNode {
  if (status === "recording")
    return (
      <Badge variant="accent" dot>
        녹음 중
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="danger" dot>
        실패
      </Badge>
    );
  if (status === "uploaded" || status === "processing")
    return (
      <Badge variant="warning" dot>
        처리 중
      </Badge>
    );
  return null;
}

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
                ? "bg-[var(--accent-solid)] text-[color:var(--text-on-accent)]"
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

function TagPills({
  tags,
  value,
  onChange,
}: {
  tags: TagSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="flex max-h-[88px] flex-wrap gap-1 overflow-y-auto px-1">
      {tags.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? null : t.id)}
            className={cn(
              "max-w-full cursor-pointer truncate rounded-full px-[9px] py-[3px] text-xs font-medium outline-none transition-colors duration-[80ms] focus-visible:[box-shadow:var(--focus-ring)]",
              active
                ? "bg-[var(--accent-bg)] text-[color:var(--accent-text)]"
                : "text-[color:var(--text-muted)] hover:bg-[var(--surface-hover)]",
            )}
          >
            #{t.name}
          </button>
        );
      })}
    </div>
  );
}

type LeftNavProps = {
  filter: MeetingFilter;
  onFilter: (f: MeetingFilter) => void;
  onOpenSearch: () => void;
};

export function LeftNav({ filter, onFilter, onOpenSearch }: LeftNavProps) {
  const navigate = useNavigate();
  const { meetingId } = useParams();
  const lensMatch = useMatch("/lenses/:kind");
  const savedMatch = useMatch("/saved-utterances");
  const speakersMatch = useMatch("/speakers");
  const settingsMatch = useMatch("/settings");
  const [newMeetingOpen, setNewMeetingOpen] = React.useState(false);
  const { data: meetings, isLoading, isError } = useMeetings();
  const { data: tags = [] } = useTags();
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  // 마지막 회의에서 떼어 낸 태그는 목록에서 사라지므로, 그 선택은 풀린 것으로 본다.
  const activeTag = tags.some((t) => t.id === tagFilter) ? tagFilter : null;
  const { data: folders } = useFolders();
  const [folderFilter, setFolderFilter] = React.useState<string | null>(null);
  // 태그와 같다 — 지워져 목록에서 사라진 폴더의 선택은 풀린 것으로 본다.
  const activeFolder = folders?.some((f) => f.id === folderFilter)
    ? folderFilter
    : null;

  // 버튼에 적힌 N 단축키. 입력 중이거나 모달이 열려 있으면 가로채지 않는다 —
  // 조합키가 없는 글자라 입력란에서 그대로 타이핑돼야 한다. 한글 자판에서는
  // key가 "ㅜ"로 오므로 물리 키(code)로 본다.
  const openNewMeeting = React.useEffectEvent(() => {
    setNewMeetingOpen(true);
  });
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyN") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing)
        return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.closest("input, textarea, select"))
      )
        return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      openNewMeeting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const filtered = (meetings ?? []).filter(
    (m) =>
      (activeFolder ? m.folderId === activeFolder : true) &&
      (filter === "fav" ? m.fav : true) &&
      (activeTag ? m.tags.some((t) => t.id === activeTag) : true),
  );
  const activeConditions =
    Number(activeFolder !== null) +
    Number(filter === "fav") +
    Number(activeTag !== null);

  return (
    <nav
      aria-label="주 탐색"
      className="flex w-[var(--rail-nav)] shrink-0 flex-col overflow-hidden border-r border-border bg-[var(--surface-panel)]"
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-2.5">
        <BrandMark size={24} className="block shrink-0" />
        <span className="text-h2 font-semibold tracking-[-0.03em] text-foreground">
          Damwha
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pt-0.5 pb-2">
        <div className="mb-3 px-0.5" data-tour="search-trigger">
          <SearchField
            asButton
            aria-label="검색 (명령 팔레트 열기)"
            onClick={onOpenSearch}
            shortcut={<Kbd keys={["⌘", "K"]} />}
          />
        </div>
        <NewMeetingItem onClick={() => setNewMeetingOpen(true)} />

        <div className="mt-3.5 flex flex-col gap-0.5">
          <SidebarItem
            icon={<Icon name="bookmark" size={16} />}
            label="저장한 발언"
            active={!!savedMatch}
            asChild
          >
            <Link to="/saved-utterances" />
          </SidebarItem>
          <SidebarItem
            icon={<Icon name="listChecks" size={16} />}
            label="할 일·결정·약속"
            active={!!lensMatch}
            asChild
          >
            <Link to="/lenses/action" />
          </SidebarItem>
          <SidebarItem
            icon={<Icon name="users" size={16} />}
            label="화자 관리"
            active={!!speakersMatch}
            asChild
          >
            <Link to="/speakers" />
          </SidebarItem>
          <SidebarItem
            icon={<Icon name="settings" size={16} />}
            label="처리 설정"
            active={!!settingsMatch}
            asChild
          >
            <Link to="/settings" />
          </SidebarItem>
        </div>

        <FolderSection
          folders={folders}
          meetings={meetings ?? []}
          value={activeFolder}
          onChange={setFolderFilter}
        />

        <SectionLabel>필터</SectionLabel>
        <FilterPills value={filter} onChange={onFilter} />
        {tags.length > 0 && (
          <>
            <SectionLabel>태그</SectionLabel>
            <TagPills tags={tags} value={activeTag} onChange={setTagFilter} />
          </>
        )}

        <SectionLabel>회의 목록</SectionLabel>
        <ul
          data-tour="meeting-list"
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain"
          aria-label="회의 목록"
          aria-busy={isLoading || undefined}
        >
          {isLoading ? (
            <li
              role="status"
              className="px-2 py-2 text-xs text-[color:var(--text-faint)]"
            >
              회의를 불러오는 중…
            </li>
          ) : isError ? (
            <li className="px-2 py-2 text-xs text-[color:var(--red-text)]">
              회의 목록을 불러오지 못했어요.
            </li>
          ) : filtered.length === 0 ? (
            <li className="px-2 py-3 text-xs leading-relaxed text-[color:var(--text-faint)]">
              {activeConditions > 1
                ? "조건에 맞는 회의가 없어요."
                : activeTag
                  ? "이 태그가 붙은 회의가 없어요."
                  : activeFolder
                    ? "이 폴더에 회의가 없어요."
                    : filter === "fav"
                      ? "즐겨찾기한 회의가 없어요."
                      : "아직 회의가 없어요. 오디오를 업로드해 시작하세요."}
            </li>
          ) : (
            filtered.map((m) => (
              <li key={m.id}>
                <SidebarItem
                  label={m.title}
                  sub={m.sub}
                  meta={statusBadge(m.status) ?? m.dur}
                  active={meetingId === m.id}
                  asChild
                >
                  <Link to={`/meetings/${m.id}`} />
                </SidebarItem>
              </li>
            ))
          )}
        </ul>
      </div>

      {env.demoMode ? (
        <React.Suspense fallback={null}>
          <TourLaunchButton />
        </React.Suspense>
      ) : null}

      <div className="flex shrink-0 items-center border-t border-[color:var(--border-subtle)] px-3 py-1.5">
        <ThemeMenu />
      </div>

      <NewMeetingDialog
        defaultFolderId={activeFolder ?? undefined}
        open={newMeetingOpen}
        onOpenChange={setNewMeetingOpen}
        onCreated={(id) => navigate(`/meetings/${id}`)}
      />
    </nav>
  );
}
