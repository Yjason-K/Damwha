import * as React from "react";
import { Outlet, useNavigate } from "react-router";

import {
  CommandBar,
  type CommandGroup,
  type CommandItem,
} from "@/shared/ui/command-bar";
import { env } from "@/shared/config/env";

import { formatClock } from "@/features/meeting/api/mappers";
import { useMeetings } from "@/features/meeting/api/meetings";
import { useFolders } from "@/features/meeting/api/folders";
import { useSearch, type SearchSince } from "@/features/meeting/api/search";
import { useTags } from "@/features/meeting/api/tags";
import { groupSearchHits } from "@/features/meeting/lib/group-search-hits";
import { useSpeakers } from "@/features/speaker/api/speakers";
import { cn } from "@/shared/lib/utils";
import { useProcessingSettings } from "@/features/settings/api/settings";
import { searchIsKeywordOnly } from "@/features/settings/lib/model-readiness";
import type { MeetingFilter } from "@/features/meeting/model/types";
import { Icon } from "@/features/meeting/ui/icons";
import { LeftNav } from "@/features/meeting/ui/left-nav";

const TourNavigationGuard = React.lazy(() =>
  import("@/features/demo/ui/tour-navigation-guard").then((m) => ({
    default: m.TourNavigationGuard,
  })),
);

/**
 * AppShell — 모든 제품 화면의 레이아웃 라우트. 2열 2행 그리드로,
 * col 1/row 1은 LeftNav, col 2/row 1은 <Outlet/>이 채운다. row 2는 회의 뷰가
 * PlayerBar를 col-span-2로 놓을 때만 높이를 갖는다(그 외에는 0으로 접힘).
 * CommandBar는 Radix Dialog Portal이라 그리드 항목이 되지 않는다.
 */

const SINCE_OPTIONS: { value: SearchSince; label: string }[] = [
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
  { value: "year", label: "올해" },
];

const facetSelectClass =
  "h-7 max-w-[150px] cursor-pointer rounded-xs border border-border bg-card px-1.5 text-xs text-foreground outline-none hover:border-[color:var(--border-strong)] focus-visible:[box-shadow:var(--focus-ring)]";

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
  const [filter, setFilter] = React.useState<MeetingFilter>("recent");
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdQuery, setCmdQuery] = React.useState("");

  const [cmdTag, setCmdTag] = React.useState<string | null>(null);
  const [cmdSince, setCmdSince] = React.useState<SearchSince | null>(null);
  const [cmdSpeaker, setCmdSpeaker] = React.useState<string | null>(null);
  const [cmdFolder, setCmdFolder] = React.useState<string | null>(null);

  const { data: meetings } = useMeetings();
  const { data: tags = [] } = useTags();
  const { data: speakers = [] } = useSpeakers();
  const { data: folders = [] } = useFolders();
  const activeCmdTag = tags.some((t) => t.id === cmdTag) ? cmdTag : null;
  const activeSpeaker = speakers.some((s) => s.id === cmdSpeaker)
    ? cmdSpeaker
    : null;
  const activeFolder = folders.some((f) => f.id === cmdFolder)
    ? cmdFolder
    : null;
  const anyFilter = !!(
    activeCmdTag ||
    activeSpeaker ||
    activeFolder ||
    cmdSince
  );
  const { data: hits = [] } = useSearch(cmdQuery, cmdOpen, {
    tagId: activeCmdTag,
    speakerId: activeSpeaker,
    folderId: activeFolder,
    since: cmdSince,
  });
  // 검색이 왜 키워드로만 도는지 (Phase 4 스펙 §6.9). 임베딩 모델이 없으면 의미 검색이 서지
  // 않는데, 그 말을 안 하면 사용자는 검색이 나빠졌다고 읽는다.
  const { data: settings } = useProcessingSettings();
  const keywordOnly = searchIsKeywordOnly(settings?.modelReadiness);

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
  // 같은 제목의 회의("테스트" 둘)를 가를 수 있도록 결과마다 날짜를 붙인다.
  const dateOf = new Map((meetings ?? []).map((m) => [m.id, m.date]));
  // 발언은 회의별 그룹으로 묶고, 같은 문장은 처음 나온 회의에만 남긴다(내용이 같은
  // 회의를 여러 번 올리면 같은 문장이 회의 수만큼 반복됐다).
  const grouped = groupSearchHits(hits);
  const hitGroups: CommandGroup[] = grouped.map((g) => ({
    label: [g.meetingTitle ?? "제목 없는 회의", dateOf.get(g.meetingId)]
      .filter(Boolean)
      .join(" · "),
    items: g.hits.map((h) => ({
      id: `u:${h.meetingId}:${h.utteranceId}`,
      icon: <Icon name="quote" size={15} />,
      title: highlight(h.text, q),
      meta:
        [
          h.speakerName,
          h.alsoIn > 0 ? `다른 회의 ${h.alsoIn}건에도 같은 발언` : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      trail: formatClock(h.startMs),
    })),
  }));

  // '회의' 그룹은 제목이 질의에 매칭되는 회의다. 발언 그룹으로 이미 나온 회의는
  // 다시 싣지 않는다. 필터는 목록 데이터로 가릴 수 있는 태그·폴더만 적용한다.
  const meetingItems: CommandItem[] = [];
  const seenMeetings = new Set<string>(grouped.map((g) => g.meetingId));
  const pushMeeting = (id: string, title: string) => {
    if (seenMeetings.has(id)) return;
    seenMeetings.add(id);
    meetingItems.push({
      id: `m:${id}`,
      icon: <Icon name="file" size={15} />,
      title,
      meta: dateOf.get(id),
    });
  };
  if (q && !activeSpeaker && !cmdSince) {
    for (const m of meetings ?? []) {
      if (activeCmdTag && !m.tags.some((t) => t.id === activeCmdTag)) continue;
      if (activeFolder && m.folderId !== activeFolder) continue;
      if (m.title.includes(q)) pushMeeting(m.id, m.title);
    }
  }

  const cmdGroups: CommandGroup[] = [
    ...hitGroups,
    { label: "제목이 맞는 회의", items: meetingItems.slice(0, 5) },
  ].filter((g) => g.items.length > 0);

  const clearFilters = () => {
    setCmdTag(null);
    setCmdSince(null);
    setCmdSpeaker(null);
    setCmdFolder(null);
  };

  return (
    <>
      <div className="grid h-screen min-w-[1260px] grid-cols-[var(--rail-nav)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] bg-[var(--surface-app)] text-foreground">
        <LeftNav
          filter={filter}
          onFilter={setFilter}
          onOpenSearch={openSearch}
        />
        <Outlet />

        <CommandBar
          open={cmdOpen}
          onOpenChange={setCmdOpen}
          query={cmdQuery}
          onQueryChange={setCmdQuery}
          facets={
            <>
              <select
                aria-label="날짜"
                value={cmdSince ?? ""}
                onChange={(e) =>
                  setCmdSince((e.target.value || null) as SearchSince | null)
                }
                className={facetSelectClass}
              >
                <option value="">모든 날짜</option>
                {SINCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {speakers.length > 0 && (
                <select
                  aria-label="화자"
                  value={activeSpeaker ?? ""}
                  onChange={(e) => setCmdSpeaker(e.target.value || null)}
                  className={facetSelectClass}
                >
                  <option value="">모든 화자</option>
                  {speakers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
              {folders.length > 1 && (
                <select
                  aria-label="폴더"
                  value={activeFolder ?? ""}
                  onChange={(e) => setCmdFolder(e.target.value || null)}
                  className={facetSelectClass}
                >
                  <option value="">모든 폴더</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
              {tags.map((t) => {
                const active = activeCmdTag === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCmdTag(active ? null : t.id)}
                    className={cn(
                      "cursor-pointer rounded-full px-[9px] py-[3px] text-xs font-medium outline-none transition-colors duration-[80ms] focus-visible:[box-shadow:var(--focus-ring)]",
                      active
                        ? "bg-[var(--accent-bg)] text-[color:var(--accent-text)]"
                        : "text-[color:var(--text-muted)] hover:bg-[var(--surface-hover)]",
                    )}
                  >
                    #{t.name}
                  </button>
                );
              })}
              {anyFilter && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-auto cursor-pointer rounded-xs text-xs font-medium text-[color:var(--text-link)] outline-none hover:underline focus-visible:[box-shadow:var(--focus-ring)]"
                >
                  필터 지우기
                </button>
              )}
            </>
          }
          notice={
            keywordOnly
              ? "검색 임베딩 모델을 아직 받는 중이라 지금은 단어가 그대로 들어간 발언만 찾아요. 모델이 준비되면 뜻이 비슷한 발언까지 찾아요."
              : undefined
          }
          groups={cmdGroups}
          onSelect={(item) => {
            if (!item.id) return;
            setCmdOpen(false);
            const [kind, mid, uid] = item.id.split(":");
            if (kind === "u") navigate(`/meetings/${mid}?u=${uid}`);
            else if (kind === "m") navigate(`/meetings/${mid}`);
          }}
        />

        {env.demoMode ? (
          <React.Suspense fallback={null}>
            <TourNavigationGuard />
          </React.Suspense>
        ) : null}
      </div>
    </>
  );
}
