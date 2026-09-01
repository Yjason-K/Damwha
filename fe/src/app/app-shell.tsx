import * as React from "react";
import { Outlet, useNavigate } from "react-router";

import {
  CommandBar,
  type CommandGroup,
  type CommandItem,
} from "@/shared/ui/command-bar";

import { formatClock } from "@/features/meeting/api/mappers";
import { useMeetings } from "@/features/meeting/api/meetings";
import { useSearch } from "@/features/meeting/api/search";
import type { MeetingFilter } from "@/features/meeting/model/types";
import { Icon } from "@/features/meeting/ui/icons";
import { LeftNav } from "@/features/meeting/ui/left-nav";

/**
 * AppShell — 모든 제품 화면의 레이아웃 라우트. 2열 2행 그리드로,
 * col 1/row 1은 LeftNav, col 2/row 1은 <Outlet/>이 채운다. row 2는 회의 뷰가
 * PlayerBar를 col-span-2로 놓을 때만 높이를 갖는다(그 외에는 0으로 접힘).
 * CommandBar는 Radix Dialog Portal이라 그리드 항목이 되지 않는다.
 */

/** Clip around the first match and wrap it in a highlighted <mark>. */
function highlight(text: string, q: string): React.ReactNode {
  const clip = (s: string) => (s.length > 52 ? `${s.slice(0, 52)}…` : s);
  if (!q) return clip(text);
  const i = text.indexOf(q);
  if (i < 0) return clip(text);
  const start = Math.max(0, i - 16);
  const slice = (start ? "…" : "") + text.slice(start);
  const j = slice.indexOf(q);
  return (
    <>
      {slice.slice(0, j)}
      <mark className="rounded-[2px] bg-[var(--accent-2)] text-[color:var(--accent-text)]">
        {q}
      </mark>
      {slice.slice(j + q.length, j + q.length + 28)}…
    </>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const [filter, setFilter] = React.useState<MeetingFilter>("all");
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdQuery, setCmdQuery] = React.useState("");

  const { data: meetings } = useMeetings();
  const { data: hits = [] } = useSearch(cmdQuery, cmdOpen);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 팔레트 열기 진입점은 레일의 검색 필드 하나다. 여는 것만 노출해(토글 아님)
  // 열림/닫힘 소유권은 셸에 남긴다.
  const openSearch = () => setCmdOpen(true);

  const q = cmdQuery.trim();
  const utteranceItems: CommandItem[] = hits.slice(0, 6).map((h) => ({
    id: `u:${h.meetingId}:${h.utteranceId}`,
    icon: <Icon name="quote" size={15} />,
    title: highlight(h.text, q),
    meta: [h.meetingTitle ?? "제목 없는 회의", h.speakerName]
      .filter(Boolean)
      .join(" · "),
    trail: formatClock(h.startMs),
  }));

  // '회의' 그룹은 발화 히트가 가리키는 회의 + 제목이 질의에 매칭되는 회의를
  // 합친다(중복 제거). 제목만 매칭되는 회의(발화 히트 없음)도 노출된다.
  const meetingItems: CommandItem[] = [];
  const seenMeetings = new Set<string>();
  const pushMeeting = (id: string, title: string) => {
    if (seenMeetings.has(id)) return;
    seenMeetings.add(id);
    meetingItems.push({
      id: `m:${id}`,
      icon: <Icon name="file" size={15} />,
      title,
    });
  };
  for (const h of hits)
    pushMeeting(h.meetingId, h.meetingTitle ?? "제목 없는 회의");
  if (q) {
    for (const m of meetings ?? []) {
      if (m.title.includes(q)) pushMeeting(m.id, m.title);
    }
  }

  const cmdGroups: CommandGroup[] = [
    { label: "발언", items: utteranceItems },
    { label: "회의", items: meetingItems.slice(0, 5) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="grid h-screen min-w-[1260px] grid-cols-[var(--rail-nav)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] bg-[var(--surface-app)] text-foreground">
      <LeftNav filter={filter} onFilter={setFilter} onOpenSearch={openSearch} />
      <Outlet />

      <CommandBar
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        query={cmdQuery}
        onQueryChange={setCmdQuery}
        groups={cmdGroups}
        onSelect={(item) => {
          if (!item.id) return;
          setCmdOpen(false);
          const [kind, mid, uid] = item.id.split(":");
          if (kind === "u") navigate(`/meetings/${mid}?u=${uid}`);
          else if (kind === "m") navigate(`/meetings/${mid}`);
        }}
      />
    </div>
  );
}
