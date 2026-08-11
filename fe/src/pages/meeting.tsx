import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  CommandBar,
  type CommandGroup,
  type CommandItem,
} from "@/shared/ui/command-bar";
import { Tag } from "@/shared/ui/tag";
import { useToast } from "@/shared/ui/use-toast";

import { useSetLensCompletion } from "@/features/lens/api/lenses";
import { LensDashboard } from "@/features/lens/ui/lens-dashboard";
import type { LensKind } from "@/features/lens/model/types";
import { useMeetingLenses } from "@/features/meeting/api/lenses";
import { formatClock, mapMeetingLenses } from "@/features/meeting/api/mappers";
import {
  useGenerateSummary,
  useMeeting,
  useMeetingStatus,
  useMeetings,
  useSyncSummaryStatus,
} from "@/features/meeting/api/meetings";
import { useSearch } from "@/features/meeting/api/search";
import type { MeetingStatusResponse } from "@/features/meeting/api/types";
import type {
  LensKind as MeetingLensKind,
  Meeting,
  MeetingFilter,
} from "@/features/meeting/model/types";
import { Icon } from "@/features/meeting/ui/icons";
import { InsightPane } from "@/features/meeting/ui/insight-pane";
import { LeftNav } from "@/features/meeting/ui/left-nav";
import { PlayerBar } from "@/features/meeting/ui/player-bar";
import { TranscriptPane } from "@/features/meeting/ui/transcript-pane";

/**
 * /app — Damwha's browse-first meeting shell. LeftNav + (transcript + insight |
 * global lens) + real-audio player, with the ⌘K structured-search palette and
 * the speaker-resolve flow. Wired to the live backend via TanStack Query.
 */

type ShellView = "meeting" | "lens";

type Facet = { id: string; label: string; speaker?: number };

const INITIAL_FACETS: Facet[] = [
  { id: "f1", label: "김영재", speaker: 1 },
  { id: "f2", label: "지난주" },
  { id: "f3", label: "기획회의" },
];

/** 처리 단계(stage) → 한국어 표기. */
const STAGE_LABELS: Record<string, string> = {
  vad: "음성 구간 감지",
  diarize: "화자 분리",
  identify: "화자 식별",
  stt: "받아쓰기",
  align: "정렬",
  persist: "저장",
  embed: "색인",
};

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

function CenterState({
  busy,
  children,
}: {
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role={busy ? "status" : undefined}
      aria-busy={busy || undefined}
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--surface-card)] px-8 text-center"
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-6 shrink-0 animate-spin rounded-full border-2 border-[color:var(--accent-solid)] border-r-transparent"
    />
  );
}

function ProcessingBanner({
  meeting,
  status,
}: {
  meeting: Meeting;
  status: MeetingStatusResponse | undefined;
}) {
  if (meeting.status === "failed") {
    return (
      <div
        role="alert"
        className="flex items-center gap-2.5 border-b border-[color:var(--red-6)] bg-[var(--red-bg)] px-7 py-2.5 text-sm"
      >
        <Icon
          name="clock"
          size={15}
          className="shrink-0 text-[color:var(--red-text)]"
        />
        <span className="font-semibold text-[color:var(--red-text)]">
          처리에 실패했어요
        </span>
        <span className="text-[color:var(--text-secondary)]">
          다시 업로드하거나 잠시 후 시도해 주세요.
        </span>
      </div>
    );
  }

  const stageLabel = status?.stage
    ? (STAGE_LABELS[status.stage] ?? "처리 중")
    : "대기 중";
  const raw = status?.progress ?? null;
  const pct = raw == null ? null : Math.round(raw <= 1 ? raw * 100 : raw);

  return (
    <div
      role="status"
      aria-busy="true"
      className="flex items-center gap-2.5 border-b border-[color:var(--accent-6)] bg-[var(--accent-1)] px-7 py-2.5 text-sm"
    >
      <span
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[color:var(--accent-solid)] border-r-transparent"
      />
      <span className="font-semibold text-[color:var(--accent-text)]">
        회의를 처리하고 있어요
      </span>
      <span className="text-[color:var(--text-secondary)]">
        {stageLabel}
        {pct != null ? ` · ${pct}%` : ""}
      </span>
    </div>
  );
}

export function MeetingPage() {
  const [view, setView] = React.useState<ShellView>("meeting");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [lens, setLens] = React.useState<LensKind>("action");
  const [tab, setTab] = React.useState("summary");
  const [filter, setFilter] = React.useState<MeetingFilter>("all");
  const [activeId, setActiveId] = React.useState("");
  const [playing, setPlaying] = React.useState(false);
  const [pos, setPos] = React.useState(0);
  const [speed, setSpeed] = React.useState(1);
  const [aiAck, setAiAck] = React.useState<Record<string, boolean>>({});
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdQuery, setCmdQuery] = React.useState("");
  const [facets, setFacets] = React.useState<Facet[]>(INITIAL_FACETS);
  const [audioDuration, setAudioDuration] = React.useState(0);
  const [pendingSeek, setPendingSeek] = React.useState<{
    mid: string;
    uid: string;
  } | null>(null);

  const {
    data: meetings,
    isLoading: meetingsLoading,
    isError: meetingsError,
  } = useMeetings();

  const currentId = selectedId ?? meetings?.[0]?.id;

  const {
    data: meeting,
    isError: meetingError,
    isFetching: meetingFetching,
    refetch: refetchMeeting,
  } = useMeeting(currentId);

  const { data: lensItems = [] } = useMeetingLenses(currentId);
  const setLensCompletion = useSetLensCompletion();
  const generateSummary = useGenerateSummary();
  const meetingLenses = React.useMemo(
    () => (meeting ? mapMeetingLenses(lensItems, meeting.speakers) : {}),
    [lensItems, meeting],
  );

  const summaryPending =
    meeting?.summaryStatus === "queued" ||
    meeting?.summaryStatus === "running" ||
    generateSummary.isPending;

  const statusEnabled =
    !!meeting &&
    (meeting.status === "uploaded" ||
      meeting.status === "processing" ||
      summaryPending);
  const { data: procStatus } = useMeetingStatus(currentId, statusEnabled);

  useSyncSummaryStatus(
    currentId,
    meeting?.summaryStatus,
    procStatus?.summary_status,
  );

  const { data: hits = [] } = useSearch(cmdQuery);

  const { toast } = useToast();

  const audioRef = React.useRef<HTMLAudioElement>(null);

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

  // Real audio transport: keep the element in sync with speed / play state.
  React.useEffect(() => {
    const a = audioRef.current;
    if (a) a.playbackRate = speed;
  }, [speed, currentId]);

  React.useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.play().catch(() => setPlaying(false));
    else a.pause();
  }, [playing]);

  // 매핑된 duration이 없으면(=null → 0) 실제 <audio>의 loadedmetadata duration으로
  // 대체해, duration_ms가 null인 회의도 플레이어를 렌더할 수 있게 한다.
  const mappedTotal = meeting?.totalSeconds ?? 0;
  const totalSeconds = mappedTotal > 0 ? mappedTotal : audioDuration;

  const seek = (fraction: number) => {
    const a = audioRef.current;
    const total =
      a && Number.isFinite(a.duration) && a.duration > 0
        ? a.duration
        : totalSeconds;
    if (a && total > 0) a.currentTime = fraction * total;
    setPos(fraction);
  };

  const openMeeting = (mid: string) => {
    setView("meeting");
    if (mid !== currentId) {
      setSelectedId(mid);
      setActiveId("");
      setPos(0);
      setPlaying(false);
      setAudioDuration(0);
    }
  };

  const jumpTo = (mid: string, uid: string) => {
    openMeeting(mid);
    setActiveId(uid);
    if (meeting && meeting.id === mid) {
      const source = meeting.utterances
        .flatMap((x) => x.sources)
        .find((s) => s.id === uid);
      if (source && totalSeconds > 0) {
        seek(Math.min(1, source.startMs / 1000 / totalSeconds));
      }
    } else {
      // 다른 회의로의 점프: 대상 회의 오디오가 준비되면(onLoadedMetadata) 적용한다.
      setPendingSeek({ mid, uid });
    }
  };

  const openLens = (k: MeetingLensKind) => {
    setView("lens");
    setLens(k);
  };

  // 전역 렌즈 대시보드에서의 근거 점프 — 오디오 seek는 하지 않고 뷰 전환 +
  // 하이라이트/스크롤만 수행한다.
  const jumpToEvidence = (mid: string, uid: string) => {
    openMeeting(mid);
    setActiveId(uid);
  };

  // historical 가드: 재처리 등으로 대상 회의가 로드된 뒤에도 activeId가 가리키는
  // 발언(원본 발화 id 포함)을 찾을 수 없으면 안내 토스트를 띄우고 activeId를
  // 비운다. 같은 회의 내 검색 점프(jumpTo)는 항상 유효한 발언만 넘기므로 영향
  // 없다. 캐시된 meeting이 stale한 채 백그라운드 재조회가 진행 중일 때 false
  // negative(아직 갱신 전 데이터로 오판)를 막기 위해 isFetching이 꺼졌을 때만
  // 판정한다. 외부 데이터(meeting)와 activeId의 조합을 동기화하는 의도된 effect라
  // set-state-in-effect 규칙을 해제한다(activeId가 ""로 바뀌면 조건이 즉시
  // false가 되어 cascading되지 않음).
  React.useEffect(() => {
    if (!activeId || !meeting || meetingFetching) return;
    const found = meeting.utterances.some(
      (u) => u.id === activeId || u.sources.some((s) => s.id === activeId),
    );
    if (!found) {
      toast({
        description: "재처리로 근거 발언을 현재 버전에서 찾을 수 없어요.",
      });
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveId("");
    }
  }, [activeId, meeting, meetingFetching, toast]);

  const handleDeleted = (deletedId: string) => {
    // 여전히 stale일 수 있는 목록에서 삭제된 id를 명시적으로 제외해 다음 선택을
    // 정한다. 남는 회의가 없으면 null → 빈 상태로 떨어진다.
    const remaining = (meetings ?? []).filter((m) => m.id !== deletedId);
    setSelectedId(remaining[0]?.id ?? null);
    setView("meeting");
    setActiveId("");
    setPos(0);
    setPlaying(false);
    setAudioDuration(0);
  };

  /* ── ⌘K structured search backed by the /search endpoint ─────────── */
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
  const cappedMeetingItems = meetingItems.slice(0, 5);

  const cmdGroups: CommandGroup[] = [
    { label: "발언", items: utteranceItems },
    { label: "회의", items: cappedMeetingItems },
  ].filter((g) => g.items.length > 0);

  const renderCenter = () => {
    if (meetingsLoading) {
      return (
        <CenterState busy>
          <Spinner />
          <p className="text-sm text-[color:var(--text-muted)]">
            회의를 불러오는 중…
          </p>
        </CenterState>
      );
    }
    if (meetingsError) {
      return (
        <CenterState>
          <Icon
            name="inbox"
            size={22}
            className="text-[color:var(--text-faint)]"
          />
          <p className="text-sm text-[color:var(--text-muted)]">
            회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
          </p>
        </CenterState>
      );
    }
    if ((meetings ?? []).length === 0) {
      return (
        <CenterState>
          <Icon
            name="mic"
            size={24}
            className="text-[color:var(--text-faint)]"
          />
          <p className="text-base font-semibold text-foreground">
            아직 회의가 없어요
          </p>
          <p className="text-sm text-[color:var(--text-muted)]">
            왼쪽의 “새 회의 기록하기”로 첫 회의를 만들어 보세요.
          </p>
        </CenterState>
      );
    }
    // 렌더 가능한 상세가 있으면 최우선으로 그린다 — 배경 재조회 실패가 렌더 가능한
    // 전사를 에러 화면으로 덮지 않도록. 그 다음이 에러, 마지막이 로딩.
    if (!meeting) {
      if (meetingError) {
        return (
          <CenterState>
            <Icon
              name="inbox"
              size={22}
              className="text-[color:var(--text-faint)]"
            />
            <p className="text-sm text-[color:var(--text-muted)]">
              회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => refetchMeeting()}
            >
              다시 시도
            </Button>
          </CenterState>
        );
      }
      return (
        <CenterState busy>
          <Spinner />
          <p className="text-sm text-[color:var(--text-muted)]">
            회의를 불러오는 중…
          </p>
        </CenterState>
      );
    }
    return (
      <>
        <TranscriptPane
          meeting={meeting}
          activeId={activeId}
          onJump={(uid) => jumpTo(meeting.id, uid)}
          onDeleted={() => handleDeleted(meeting.id)}
          aiAcked={!!aiAck[meeting.id]}
          onAckAi={() => setAiAck((a) => ({ ...a, [meeting.id]: true }))}
          onShowSummary={() => setTab("summary")}
          onOpenSearch={() => setCmdOpen(true)}
        />
        <InsightPane
          meeting={meeting}
          lenses={meetingLenses}
          tab={tab}
          onTab={setTab}
          onToggle={(id, doneVal) =>
            setLensCompletion.mutate({ id, done: doneVal })
          }
          onOpenLens={openLens}
          onJumpSegment={(uid) => jumpToEvidence(meeting.id, uid)}
          onRegenerateSummary={() => generateSummary.mutate({ id: meeting.id })}
          regenerating={generateSummary.isPending}
        />
      </>
    );
  };

  return (
    <div className="flex h-screen min-w-[1160px] flex-col bg-[var(--surface-app)] text-foreground">
      <div className="flex min-h-0 flex-1">
        <LeftNav
          currentId={currentId ?? ""}
          view={view}
          filter={filter}
          onFilter={setFilter}
          onSelectMeeting={openMeeting}
          onSelectLens={openLens}
          onOpenSearch={() => setCmdOpen(true)}
        />
        {view === "meeting" ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {meeting && meeting.status !== "done" ? (
              <ProcessingBanner meeting={meeting} status={procStatus} />
            ) : null}
            <div className="flex min-h-0 flex-1">{renderCenter()}</div>
          </div>
        ) : (
          <LensDashboard
            lens={lens}
            onLens={setLens}
            onJumpEvidence={jumpToEvidence}
          />
        )}
      </div>

      {view === "meeting" && meeting && totalSeconds > 0 ? (
        <PlayerBar
          key={`playbar-${meeting.id}`}
          tracks={meeting.tracks}
          playing={playing}
          pos={pos}
          totalSeconds={totalSeconds}
          durLabel={
            mappedTotal > 0 ? meeting.dur : formatClock(totalSeconds * 1000)
          }
          speed={speed}
          onSpeed={setSpeed}
          onToggle={() => setPlaying((p) => !p)}
          onSeek={seek}
        />
      ) : null}

      {meeting ? (
        <audio
          key={meeting.id}
          ref={audioRef}
          src={meeting.audioUrl}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            const d = el.duration;
            const hasReal = Number.isFinite(d) && d > 0;
            if (hasReal) setAudioDuration(d);
            // 대기 중인 cross-meeting seek을 오디오가 준비된 지금 적용한다.
            const total = hasReal ? d : totalSeconds;
            if (pendingSeek && meeting.id === pendingSeek.mid && total > 0) {
              const source = meeting.utterances
                .flatMap((x) => x.sources)
                .find((s) => s.id === pendingSeek.uid);
              if (source) {
                const fraction = Math.min(1, source.startMs / 1000 / total);
                el.currentTime = fraction * total;
                setPos(fraction);
              }
              setPendingSeek(null);
            }
          }}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            const total =
              Number.isFinite(a.duration) && a.duration > 0
                ? a.duration
                : totalSeconds;
            if (total > 0) setPos(Math.min(1, a.currentTime / total));
          }}
          onEnded={() => setPlaying(false)}
        />
      ) : null}

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
