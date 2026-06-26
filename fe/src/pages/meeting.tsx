import * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { IconButton } from "@/shared/ui/icon-button";
import { Kbd } from "@/shared/ui/kbd";
import { SearchField } from "@/shared/ui/search-field";
import { SidebarItem } from "@/shared/ui/sidebar-item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Utterance } from "@/shared/ui/utterance";
import { SpeakerTrack } from "@/shared/ui/speaker-track";
import { LensItem } from "@/shared/ui/lens-item";
import { CommandBar, type CommandGroup } from "@/shared/ui/command-bar";

/* ── icons ───────────────────────────────────────────────── */
function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.5h5L12.5 5v9.5H4z" />
      <path d="M9 1.5V5h3.5" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4" y="3" width="3" height="10" rx="1" />
      <rect x="9" y="3" width="3" height="10" rx="1" />
    </svg>
  );
}
function QuoteIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 9.5C3 6.5 5 4.5 7.5 4l.4 1.3C6.4 5.8 5.5 6.7 5.4 8H7v3.5H3zM9 9.5C9 6.5 11 4.5 13.5 4l.4 1.3c-1.5.5-2.4 1.4-2.5 2.7H13v3.5H9z" />
    </svg>
  );
}

/* ── mock corpus (Damwha sample meeting) ─────────────────── */
const SPEAKERS: Record<number, { name: string; role: string }> = {
  1: { name: "김영재", role: "PM" },
  2: { name: "이수민", role: "Designer" },
  3: { name: "박지원", role: "Eng" },
  4: { name: "정민호", role: "Eng" },
  5: { name: "한서연", role: "Eng" },
};

const MEETINGS = [
  { id: "m1", title: "기획회의 — UI 개선안", date: "6월 21일", dur: "42:00", attendees: [1, 2, 3, 4] },
  { id: "m2", title: "스프린트 회고", date: "6월 18일", dur: "58:17", attendees: [1, 2, 3, 4, 5] },
  { id: "m3", title: "검색 인덱싱 설계", date: "6월 14일", dur: "35:42", attendees: [1, 3, 4] },
  { id: "m4", title: "이수민 1:1", date: "6월 20일", dur: "22:18", attendees: [1, 2] },
  { id: "m5", title: "디자인 리뷰", date: "6월 12일", dur: "31:07", attendees: [2, 3, 4] },
];

const UTTERANCES = [
  { id: "u1", spk: 1, t: "11:48", text: "오늘은 홈 구조부터 정하죠. 앱을 열면 뭘 먼저 보여줄지요." },
  { id: "u2", spk: 2, t: "11:55", text: "저는 브라우즈 우선이 맞다고 봐요. 검색 우선은 코퍼스가 없을 때 빈 화면이 되니까요." },
  { id: "u3", spk: 1, t: "12:04", text: "동의해요. 대신 검색은 어디서든 한 키로 부를 수 있어야 해요. ⌘K처럼요." },
  { id: "u4", spk: 3, t: "12:11", text: "검색을 상시 기능으로 두면 인덱싱이 먼저 붙어야 합니다. 이번 스프린트에 넣죠." },
  { id: "u5", spk: 2, t: "12:19", text: "그럼 UI 개선안은 다음 스프린트로 넘기는 게 좋겠네요. 사이드바 정리부터요." },
  { id: "u6", spk: 4, t: "12:26", text: "인덱싱은 키워드랑 의미 임베딩 둘 다 태우는 걸로 할게요. 오늘 안에 초안 정리하겠습니다." },
  { id: "u7", spk: 1, t: "12:38", text: "좋아요. 그리고 성문 데이터는 로컬에만 두는 전제 다시 확인하고요." },
  { id: "u8", spk: 3, t: "12:47", text: "네, 내보내기는 기본으로 꺼두고 확인 단계를 넣는 걸로 합의했었죠." },
];

const TRACKS = [
  { spk: 1, name: "김영재", dur: "12:30", segments: [{ start: 0.01, end: 0.1 }, { start: 0.18, end: 0.22 }, { start: 0.32, end: 0.37 }, { start: 0.55, end: 0.7 }] },
  { spk: 2, name: "이수민", dur: "08:14", segments: [{ start: 0.11, end: 0.17 }, { start: 0.38, end: 0.52 }, { start: 0.74, end: 0.83 }] },
  { spk: 3, name: "박지원", dur: "05:02", segments: [{ start: 0.23, end: 0.27 }, { start: 0.62, end: 0.66 }, { start: 0.9, end: 0.97 }] },
  { spk: 4, name: "정민호", dur: "03:40", segments: [{ start: 0.28, end: 0.31 }, { start: 0.71, end: 0.73 }, { start: 0.84, end: 0.88, soft: true }] },
];

const SUMMARY = [
  "사이드바(브라우즈) 우선, 검색은 ⌘K로 상시 호출하는 홈 구조를 확정.",
  "검색 인덱싱을 이번 스프린트에서 먼저 붙이고, UI 개선안은 다음 스프린트로 이월.",
  "성문 데이터는 로컬 보관, 내보내기는 기본 비활성 + 확인 단계로 처리.",
];

const ACTIONS = [
  { id: "a1", text: "검색 인덱싱(키워드 + 의미 임베딩) 초안 정리", source: "ai" as const, who: 4, ev: "12:26" },
  { id: "a2", text: "UI 개선안 — 사이드바 정리부터 디자인 검토", source: "hint" as const, who: 2, ev: "12:19" },
];

const DECISIONS = [
  { id: "d1", text: "홈은 브라우즈 우선, 검색 상시 제공", ev: "12:04" },
  { id: "d2", text: "검색 인덱싱 방식: 키워드 + 의미 임베딩", ev: "12:26" },
  { id: "d3", text: "데이터 보안: 로컬 보관, 내보내기 기본 비활성", ev: "12:47" },
];

const TRACK_LABEL_W = 88;
const TOTAL_SECONDS = 42 * 60;
function fmt(fraction: number) {
  const s = Math.round(fraction * TOTAL_SECONDS);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ── shell ───────────────────────────────────────────────── */
export function MeetingPage() {
  const [currentId, setCurrentId] = React.useState("m1");
  const [activeId, setActiveId] = React.useState("u4");
  const [tab, setTab] = React.useState("summary");
  const [playing, setPlaying] = React.useState(false);
  const [pos, setPos] = React.useState(0.34);
  const [done, setDone] = React.useState<Record<string, boolean>>({ a2: false });
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdQuery, setCmdQuery] = React.useState("");

  const meeting = MEETINGS.find((m) => m.id === currentId) ?? MEETINGS[0];

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

  React.useEffect(() => {
    if (!playing) return;
    const h = window.setInterval(
      () => setPos((p) => Math.min(1, p + 0.0022)),
      60,
    );
    return () => window.clearInterval(h);
  }, [playing]);

  const q = cmdQuery.trim();
  const cmdGroups: CommandGroup[] = [
    {
      label: "발언",
      items: UTTERANCES.filter((u) => !q || u.text.includes(q))
        .slice(0, 4)
        .map((u) => ({
          id: u.id,
          icon: <QuoteIcon />,
          title: u.text.length > 46 ? `${u.text.slice(0, 46)}…` : u.text,
          meta: `${MEETINGS[0].title} · ${SPEAKERS[u.spk].name}`,
          trail: u.t,
        })),
    },
    {
      label: "회의",
      items: MEETINGS.filter((m) => !q || m.title.includes(q))
        .slice(0, 3)
        .map((m) => ({
          id: m.id,
          icon: <FileIcon />,
          title: m.title,
          meta: `${m.date} · ${m.dur}`,
          trail: `${m.attendees.length}명`,
        })),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="flex h-screen min-w-[960px] flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-[var(--surface-panel)] px-4">
        <div className="flex w-[232px] shrink-0 items-center gap-2">
          <span className="inline-block size-5 rounded-[6px] bg-primary" aria-hidden="true" />
          <span className="text-h3 font-bold tracking-[-0.018em]">Damwha</span>
        </div>
        <SearchField
          asButton
          aria-label="검색 (명령 팔레트 열기)"
          shortcut={<Kbd>⌘K</Kbd>}
          onClick={() => setCmdOpen(true)}
          className="mx-auto max-w-[460px]"
        />
        <div className="flex w-[232px] shrink-0 justify-end">
          <Avatar name="김영재" speaker={1} size="sm" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left nav */}
        <nav
          aria-label="회의 목록"
          className="flex w-[264px] shrink-0 flex-col border-r border-border bg-[var(--surface-panel)]"
        >
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="px-2 pt-2 pb-1 text-2xs font-semibold tracking-[var(--tracking-wide)] text-[color:var(--text-faint)] uppercase">
              최근 회의
            </div>
            <ul className="flex flex-col gap-0.5">
              {MEETINGS.map((m) => (
                <li key={m.id}>
                  <SidebarItem
                    icon={<FileIcon />}
                    label={m.title}
                    sub={`${m.date} · ${m.dur}`}
                    active={m.id === currentId}
                    count={m.id === "m1" ? 5 : undefined}
                    onClick={() => setCurrentId(m.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {/* Transcript pane */}
        <main className="flex min-w-0 flex-1 flex-col bg-card">
          <div className="shrink-0 border-b border-border px-6 py-4">
            <h1 className="text-h1 font-semibold tracking-[-0.008em]">
              {meeting.title}
            </h1>
            <div className="mt-1.5 flex items-center gap-3">
              <span className="font-mono text-xs text-[color:var(--text-muted)]">
                {meeting.date} · {meeting.dur}
              </span>
              <div className="flex -space-x-1.5">
                {meeting.attendees.map((spk) => (
                  <Avatar
                    key={spk}
                    name={SPEAKERS[spk].name}
                    speaker={spk}
                    size="xs"
                    className="ring-2 ring-[var(--surface-card)]"
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <div
              className="mx-auto max-w-[720px] px-4 py-4"
              role="log"
              aria-label="회의 전사"
            >
              {UTTERANCES.map((u) => (
                <Utterance
                  key={u.id}
                  speaker={u.spk}
                  name={SPEAKERS[u.spk].name}
                  time={u.t}
                  active={u.id === activeId}
                  onJump={() => setActiveId(u.id)}
                >
                  {u.text}
                </Utterance>
              ))}
            </div>
          </div>
        </main>

        {/* Insight pane */}
        <aside
          aria-label="인사이트"
          className="flex w-[320px] shrink-0 flex-col border-l border-border bg-[var(--surface-panel)]"
        >
          <Tabs
            value={tab}
            onValueChange={setTab}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="shrink-0 px-3 pt-3">
              <TabsList>
                <TabsTrigger value="summary">요약</TabsTrigger>
                <TabsTrigger value="action">
                  액션
                  <span className="rounded-xs bg-[var(--gray-3)] px-[5px] py-px font-mono text-2xs text-[color:var(--text-faint)]">
                    {ACTIONS.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="decision">결정</TabsTrigger>
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <TabsContent value="summary">
                <ul className="flex flex-col gap-3">
                  {SUMMARY.map((s, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--accent-solid)]"
                        aria-hidden="true"
                      />
                      <span className="text-sm leading-normal text-pretty text-foreground">
                        {s}
                      </span>
                    </li>
                  ))}
                </ul>
              </TabsContent>
              <TabsContent value="action">
                <div className="flex flex-col gap-2">
                  {ACTIONS.map((a) => (
                    <LensItem
                      key={a.id}
                      source={a.source}
                      checkable
                      done={!!done[a.id]}
                      onToggle={() =>
                        setDone((d) => ({ ...d, [a.id]: !d[a.id] }))
                      }
                      assignee={SPEAKERS[a.who].name}
                      assigneeSpeaker={a.who}
                      evidence={a.ev}
                      onJump={() => setActiveId("u6")}
                    >
                      {a.text}
                    </LensItem>
                  ))}
                </div>
              </TabsContent>
              <TabsContent value="decision">
                <div className="flex flex-col gap-2">
                  {DECISIONS.map((d) => (
                    <LensItem
                      key={d.id}
                      source="ai"
                      evidence={d.ev}
                      onJump={() => setActiveId("u4")}
                    >
                      {d.text}
                    </LensItem>
                  ))}
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </aside>
      </div>

      {/* Player bar — multi-speaker timeline */}
      <footer className="flex shrink-0 items-center gap-4 border-t border-border bg-[var(--surface-panel)] px-4 py-3">
        <IconButton
          label={playing ? "일시정지" : "재생"}
          variant="outline"
          size="lg"
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
          {TRACKS.map((tr) => (
            <SpeakerTrack
              key={tr.spk}
              speaker={tr.spk}
              name={tr.name}
              duration={tr.dur}
              segments={tr.segments}
              showPlayhead={false}
              onSeek={setPos}
              labelWidth={TRACK_LABEL_W}
            />
          ))}
          {/* Single playhead spanning every lane. The wrapper is inset to the
              lane column (label + 12px gap on the left, 44px duration + 12px
              gap on the right) so it lines up with each track's segments. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-10"
            style={{
              left: `calc(${TRACK_LABEL_W}px + 0.75rem)`,
              right: "calc(44px + 0.75rem)",
            }}
          >
            <div
              className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-[1px] bg-[var(--accent-solid)]"
              style={{ left: `${pos * 100}%` }}
            >
              <span className="absolute -top-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-[var(--accent-solid)]" />
            </div>
          </div>
        </div>
        <span className="shrink-0 font-mono text-xs text-[color:var(--text-muted)]">
          {fmt(pos)} / {meeting.dur}
        </span>
      </footer>

      <CommandBar
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        query={cmdQuery}
        onQueryChange={setCmdQuery}
        groups={cmdGroups}
        onSelect={(item) => {
          setCmdOpen(false);
          if (item.id?.startsWith("u")) setActiveId(item.id);
          else if (item.id) setCurrentId(item.id);
        }}
      />
    </div>
  );
}
