import * as React from "react";

import { CommandBar, type CommandGroup } from "@/shared/ui/command-bar";
import { Tag } from "@/shared/ui/tag";

import {
  MEETING_ORDER,
  MEETINGS,
  SPEAKERS,
  durToSeconds,
  type LensKind,
  type MeetingFilter,
} from "@/features/meeting/model/data";
import { Icon } from "@/features/meeting/ui/icons";
import { InsightPane } from "@/features/meeting/ui/insight-pane";
import { LeftNav } from "@/features/meeting/ui/left-nav";
import { LensView } from "@/features/meeting/ui/lens-view";
import { PlayerBar } from "@/features/meeting/ui/player-bar";
import { TranscriptPane } from "@/features/meeting/ui/transcript-pane";

/**
 * /app — Damwha's browse-first meeting shell, ported from the Damwha Design
 * System UI kit (`ui_kits/timbre_app/TimbreApp.jsx`): LeftNav + (transcript +
 * insight | global lens) + player, with the ⌘K structured-search palette and
 * the speaker-verify flow. Runs on the mock corpus — no backend calls yet.
 */

type ShellView = "meeting" | "lens";

type Facet = { id: string; label: string; speaker?: number };

const INITIAL_FACETS: Facet[] = [
  { id: "f1", label: "김영재", speaker: 1 },
  { id: "f2", label: "지난주" },
  { id: "f3", label: "기획회의" },
];

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

export function MeetingPage() {
  const [view, setView] = React.useState<ShellView>("meeting");
  const [currentId, setCurrentId] = React.useState("m1");
  const [lens, setLens] = React.useState<LensKind>("action");
  const [tab, setTab] = React.useState("summary");
  const [filter, setFilter] = React.useState<MeetingFilter>("all");
  const [activeId, setActiveId] = React.useState("u4");
  const [playing, setPlaying] = React.useState(false);
  const [pos, setPos] = React.useState(0.34);
  const [speed, setSpeed] = React.useState(1);
  const [done, setDone] = React.useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = React.useState<Record<string, number[]>>(
    {},
  );
  const [aiAck, setAiAck] = React.useState<Record<string, boolean>>({});
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdQuery, setCmdQuery] = React.useState("");
  const [facets, setFacets] = React.useState<Facet[]>(INITIAL_FACETS);

  const meeting = MEETINGS[currentId] ?? MEETINGS.m1;
  const totalSeconds = durToSeconds(meeting.dur);

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

  const posRef = React.useRef(pos);
  React.useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  React.useEffect(() => {
    if (!playing) return;
    const h = window.setInterval(() => {
      const next = Math.min(1, posRef.current + 0.0022 * speed);
      setPos(next);
      if (next >= 1) setPlaying(false);
    }, 60);
    return () => window.clearInterval(h);
  }, [playing, speed]);

  const pendingSpeakers = (meeting.unverified ?? []).filter(
    (s) => !(confirmed[currentId] ?? []).includes(s),
  );
  const settle = () => {
    setConfirmed((c) => ({
      ...c,
      [currentId]: [...(c[currentId] ?? []), pendingSpeakers[0]],
    }));
  };

  const openMeeting = (mid: string) => {
    const m = MEETINGS[mid];
    setView("meeting");
    if (mid !== currentId) {
      setCurrentId(mid);
      setActiveId(m.utterances[0]?.id ?? "");
      setPos(0);
      setPlaying(false);
    }
  };

  const jumpTo = (mid: string, uid: string) => {
    openMeeting(mid);
    const list = MEETINGS[mid].utterances;
    const idx = Math.max(
      0,
      list.findIndex((u) => u.id === uid),
    );
    setActiveId(uid);
    if (list.length > 0)
      setPos(0.05 + (idx / Math.max(1, list.length - 1)) * 0.9);
  };

  const openLens = (k: LensKind) => {
    setView("lens");
    setLens(k);
  };

  const toggleDone = (id: string) => setDone((d) => ({ ...d, [id]: !d[id] }));

  /* ── ⌘K structured search over the whole corpus ─────────── */
  const q = cmdQuery.trim();
  const utteranceHits = MEETING_ORDER.flatMap((mid) =>
    MEETINGS[mid].utterances
      .filter((u) => !q || u.text.includes(q))
      .map((u) => ({ mid, u })),
  )
    .slice(0, 4)
    .map(({ mid, u }) => ({
      id: `u:${mid}:${u.id}`,
      icon: <Icon name="quote" size={15} />,
      title: highlight(u.text, q),
      meta: `${MEETINGS[mid].subOverride ?? MEETINGS[mid].title} · ${SPEAKERS[u.spk].name}`,
      trail: u.t,
    }));
  const meetingHits = MEETING_ORDER.map((mid) => MEETINGS[mid])
    .filter((m) => !q || (m.subOverride ?? m.title).includes(q))
    .slice(0, 3)
    .map((m) => ({
      id: `m:${m.id}`,
      icon: <Icon name="file" size={15} />,
      title: m.subOverride ?? m.title,
      meta: `${m.date} · ${m.dur}`,
      trail: `${m.attendees.length}명`,
    }));
  const cmdGroups: CommandGroup[] = [
    { label: "발언", items: utteranceHits },
    { label: "회의", items: meetingHits },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="flex h-screen min-w-[1160px] flex-col bg-[var(--surface-app)] text-foreground">
      <div className="flex min-h-0 flex-1">
        <LeftNav
          currentId={currentId}
          view={view}
          filter={filter}
          onFilter={setFilter}
          onSelectMeeting={openMeeting}
          onSelectLens={openLens}
          onOpenSearch={() => setCmdOpen(true)}
        />
        {view === "meeting" ? (
          <>
            <TranscriptPane
              meeting={meeting}
              activeId={activeId}
              onJump={(uid) => jumpTo(currentId, uid)}
              pending={pendingSpeakers}
              onConfirm={settle}
              onReject={settle}
              aiAcked={!!aiAck[currentId]}
              onAckAi={() => setAiAck((a) => ({ ...a, [currentId]: true }))}
              onShowSummary={() => setTab("summary")}
              onOpenSearch={() => setCmdOpen(true)}
            />
            <InsightPane
              meeting={meeting}
              tab={tab}
              onTab={setTab}
              done={done}
              onToggle={toggleDone}
              onOpenLens={openLens}
            />
          </>
        ) : (
          <LensView
            lens={lens}
            onLens={setLens}
            done={done}
            onToggle={toggleDone}
            onJump={openMeeting}
          />
        )}
      </div>

      {view === "meeting" && (
        <PlayerBar
          tracks={meeting.tracks}
          playing={playing}
          pos={pos}
          totalSeconds={totalSeconds}
          durLabel={meeting.dur}
          speed={speed}
          onSpeed={setSpeed}
          onToggle={() => setPlaying((p) => !p)}
          onSeek={setPos}
        />
      )}

      <CommandBar
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        query={cmdQuery}
        onQueryChange={setCmdQuery}
        facets={
          facets.length > 0 ? (
            <>
              {facets.map((f) => (
                <Tag
                  key={f.id}
                  speaker={f.speaker}
                  onRemove={() =>
                    setFacets((fs) => fs.filter((x) => x.id !== f.id))
                  }
                >
                  {f.label}
                </Tag>
              ))}
            </>
          ) : undefined
        }
        groups={cmdGroups}
        onSelect={(item) => {
          if (!item.id) return;
          setCmdOpen(false);
          const [kind, mid, uid] = item.id.split(":");
          if (kind === "u") jumpTo(mid, uid);
          else if (kind === "m") openMeeting(mid);
        }}
      />
    </div>
  );
}
