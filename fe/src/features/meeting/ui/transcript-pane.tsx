import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { IconButton } from "@/shared/ui/icon-button";
import { Input } from "@/shared/ui/input";
import { SearchField } from "@/shared/ui/search-field";
import { toast } from "@/shared/ui/use-toast";
import { Utterance } from "@/shared/ui/utterance";
import {
  useRemoveSavedUtterance,
  useSavedUtteranceIds,
  useSaveUtterance,
} from "@/features/saved-utterance/api/saved-utterances";

import {
  useDeleteMeeting,
  useRenameMeeting,
  useToggleFavorite,
} from "../api/meetings";
import { findMatches, type FindMatch } from "../lib/find-matches";
import type { Meeting } from "../model/types";
import { Icon } from "./icons";
import { ExportDialog } from "./export-dialog";
import { ReprocessDialog } from "./reprocess-dialog";
import { ResolveDialog } from "./resolve-dialog";

/**
 * TranscriptPane — center pane: meta header, attendee pills, speaker-verify
 * banner, AI-suggestion banner, utterances, 찾기 바. Ported from the
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

function TrashMini() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7M10 11v6M14 11v6" />
    </svg>
  );
}

/**
 * 발화 텍스트를 매칭 경계로 쪼개 <mark>로 감싼다. 매칭이 없으면 문자열을
 * 그대로 돌려준다(대부분의 발화가 이 경로).
 */
function renderFindText(
  text: string,
  matches: FindMatch[],
  current: FindMatch | null,
): React.ReactNode {
  if (matches.length === 0) return text;
  const out: React.ReactNode[] = [];
  let at = 0;
  matches.forEach((m, i) => {
    if (m.start > at) out.push(text.slice(at, m.start));
    const isCurrent =
      current != null && current.uid === m.uid && current.start === m.start;
    out.push(
      <mark
        key={i}
        {...(isCurrent ? { "data-find-current": "" } : {})}
        className={cn(
          "rounded-[2px]",
          isCurrent
            ? "bg-[var(--accent-solid)] text-white"
            : "bg-[var(--accent-2)] text-[color:var(--accent-text)]",
        )}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
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

/** 미해결 화자가 있으면 확인을 유도하는 배너 — 클릭 시 ResolveDialog를 연다. */
function VerifyBanner({
  count,
  onResolve,
}: {
  count: number;
  onResolve: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="mb-3.5 flex items-center gap-3 rounded-md border border-dashed border-[color:var(--border-strong)] bg-[var(--gray-0)] px-3.5 py-[11px]">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--gray-2)] text-[color:var(--text-muted)]">
        <Icon name="users" size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">
          확인이 필요한 화자가 {count}명 있어요
        </div>
        <div className="mt-px text-xs text-[color:var(--text-secondary)]">
          성문으로 자동 연결하지 못한 화자를 확인해 주세요.
        </div>
      </div>
      <Button
        variant="primary"
        size="sm"
        iconLeft={<Icon name="check" size={14} strokeWidth={2.4} />}
        onClick={onResolve}
      >
        화자 확인
      </Button>
    </div>
  );
}

function RenameDialog({
  meeting,
  open,
  onOpenChange,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rename = useRenameMeeting();
  const [title, setTitle] = React.useState(meeting.title);

  // Reset the field to the current title each time the dialog opens
  // (adjust-state-on-prop-change during render — avoids a setState-in-effect).
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTitle(meeting.title);
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = title.trim();
    if (!next) return;
    rename.mutate(
      { id: meeting.id, title: next },
      {
        onSuccess: () => {
          toast({ variant: "success", title: "회의 이름을 변경했어요." });
          onOpenChange(false);
        },
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "이름 변경에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>회의 이름 변경</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            label="회의 이름"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">취소</Button>
            </DialogClose>
            <Button
              type="submit"
              loading={rename.isPending}
              disabled={!title.trim()}
            >
              변경
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  meeting,
  open,
  onOpenChange,
  onDeleted,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const del = useDeleteMeeting();

  const submit = () => {
    del.mutate(
      { id: meeting.id },
      {
        onSuccess: () => {
          toast({ variant: "success", title: "회의를 삭제했어요." });
          onOpenChange(false);
          onDeleted();
        },
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "삭제에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>회의를 삭제할까요?</DialogTitle>
          <DialogDescription>
            “{meeting.title}” 회의와 전사·화자 연결이 모두 삭제돼요. 이 작업은
            되돌릴 수 없어요.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">취소</Button>
          </DialogClose>
          <Button variant="danger" onClick={submit} loading={del.isPending}>
            삭제
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 사용자가 직접 스크롤한 뒤 재생 따라가기를 쉬는 시간. */
const FOLLOW_GRACE_MS = 4_000;

type TranscriptPaneProps = {
  meeting: Meeting;
  activeId: string;
  /** 지금 재생 중인 블록 id — 좌측 bar 표시 + 재생 중이면 따라 스크롤. */
  playingId?: string | null;
  playing?: boolean;
  onJump: (uid: string) => void;
  onDeleted: () => void;
  aiAcked: boolean;
  onAckAi: () => void;
  onShowSummary: () => void;
};

export function TranscriptPane({
  meeting,
  activeId,
  playingId = null,
  playing = false,
  onJump,
  onDeleted,
  aiAcked,
  onAckAi,
  onShowSummary,
}: TranscriptPaneProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [resolveOpen, setResolveOpen] = React.useState(false);
  const [reprocessOpen, setReprocessOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const savedIds = useSavedUtteranceIds(meeting.id);
  const saveUtterance = useSaveUtterance();
  const removeSavedUtterance = useRemoveSavedUtterance();

  const [query, setQuery] = React.useState("");
  // 현재 매칭을 인덱스가 아니라 값으로 들고 인덱스를 파생시킨다. matches는
  // meeting.utterances에서 파생되는데 전사는 같은 회의가 마운트된 채로도
  // 바뀐다(화자 확정·재처리·요약 재생성이 ["meeting", id]를 무효화한다).
  // 인덱스를 state로 들면 매칭이 줄었을 때 카운터가 "6/2"가 되고 현재
  // 하이라이트는 아무 데도 붙지 않는다.
  const [anchor, setAnchor] = React.useState<FindMatch | null>(null);
  const findInputRef = React.useRef<HTMLInputElement>(null);

  const matches = React.useMemo(
    () => findMatches(meeting.utterances, query),
    [meeting.utterances, query],
  );

  const cursor = React.useMemo(() => {
    if (!anchor) return 0;
    const i = matches.findIndex(
      (m) =>
        m.uid === anchor.uid &&
        m.start === anchor.start &&
        m.end === anchor.end,
    );
    return i >= 0 ? i : 0; // 앵커가 사라졌으면 첫 매칭으로
  }, [matches, anchor]);

  const current = matches[cursor] ?? null;

  const matchesByUid = React.useMemo(() => {
    const map = new Map<string, FindMatch[]>();
    for (const m of matches) {
      const list = map.get(m.uid);
      if (list) list.push(m);
      else map.set(m.uid, [m]);
    }
    return map;
  }, [matches]);

  const clearFind = () => {
    setQuery("");
    setAnchor(null);
    findInputRef.current?.focus();
  };

  /** 매칭 간 순환 이동. 오디오·URL은 건드리지 않는다(Ctrl+F 의미론). */
  const go = (delta: number) => {
    if (matches.length === 0) return;
    setAnchor(matches[(cursor + delta + matches.length) % matches.length]);
  };

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // IME 조합 중(한글 음절 등)인 키 입력은 후보 확정/선택이지 매칭 이동이
    // 아니다 — 조합 중이면 아무 것도 하지 않고 IME에 그대로 맡긴다.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "Escape") {
      if (query) {
        setQuery("");
        setAnchor(null);
      } else {
        e.currentTarget.blur();
      }
    }
  };

  const favorite = useToggleFavorite();
  const fav = !!meeting.fav;
  const toggleFav = () =>
    favorite.mutate(
      { id: meeting.id, fav: !fav },
      {
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "즐겨찾기 변경에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          });
        },
      },
    );

  const pendingCount = meeting.clusters.filter(
    (c) => c.resolvedSpeakerId == null || c.speakerStatus === "provisional",
  ).length;

  // activeId는 원본 발화 id일 수 있다(검색 히트가 병합 블록 중간을 가리킴).
  // 포함하는 블록의 id로 해석해 하이라이트·스크롤 대상을 정한다.
  const activeBlockId = activeId
    ? (meeting.utterances.find((u) => u.sources.some((s) => s.id === activeId))
        ?.id ?? "")
    : "";

  // Utterance-jump: reveal the active utterance when it changes. On a jump
  // within the same meeting (⌘K·원문 보기), also move focus to the target so
  // keyboard/SR users land where the jump went — skipped on first render and
  // on meeting switches. setTimeout lets Radix's dialog focus-return run first.
  const prevRef = React.useRef<{ mid: string; uid: string } | null>(null);
  React.useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-uid="${activeBlockId}"]`,
    );
    const prev = prevRef.current;
    prevRef.current = { mid: meeting.id, uid: activeId };
    if (!el) return;
    el.scrollIntoView?.({ block: "nearest" });
    if (prev && prev.mid === meeting.id && prev.uid !== activeId) {
      const t = window.setTimeout(() => el.focus({ preventScroll: true }), 0);
      return () => window.clearTimeout(t);
    }
  }, [activeId, activeBlockId, meeting.id]);

  // 재생 따라가기: 재생 중에 현재 블록이 바뀌면 그 블록을 드러낸다. 사용자가
  // 방금 직접 스크롤했다면(다른 곳을 읽는 중) FOLLOW_GRACE_MS 동안 쉰다 —
  // 프로그램 스크롤은 wheel/touch/키 입력을 내지 않으므로 그것들만 사용자
  // 조작으로 본다.
  const userScrollAtRef = React.useRef(-Infinity);
  const markUserScroll = () => {
    userScrollAtRef.current = Date.now();
  };
  React.useEffect(() => {
    if (!playing || !playingId) return;
    if (Date.now() - userScrollAtRef.current < FOLLOW_GRACE_MS) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-uid="${playingId}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [playing, playingId]);

  React.useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>("[data-find-current]")
      ?.scrollIntoView({ block: "center" });
  }, [cursor, matches]);

  // ⌘F/Ctrl+F로 찾기 입력에 진입한다. 회의 화면에서만 마운트되므로 다른
  // 라우트에는 영향이 없다. 모달이 열려 있으면 가로채지 않는다 — Radix
  // 포커스 트랩이 focus()를 되뺏어가며 싸우므로, 그땐 브라우저 기본 찾기에
  // 양보한다. role="dialog" + data-state는 Radix가 항상 세우는 공개 계약이다.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      findInputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-card)]">
      {/* header: title + actions, meta, attendees */}
      <div className="shrink-0 px-7 py-3.5">
        <div className="mb-[11px] flex items-center gap-2">
          <h1 className="min-w-0 truncate text-h1 font-semibold tracking-[-0.02em] text-foreground">
            {meeting.title}
          </h1>
          <IconButton
            label={fav ? "즐겨찾기 해제" : "즐겨찾기"}
            size="sm"
            pressed={fav}
            onClick={toggleFav}
          >
            <Icon name="star" size={17} />
          </IconButton>
          <IconButton
            label="이름 변경"
            size="sm"
            onClick={() => setRenameOpen(true)}
          >
            <Icon name="pencil" size={16} />
          </IconButton>
          <IconButton
            label="삭제"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            <TrashMini />
          </IconButton>
          {meeting.status === "done" && (
            <IconButton
              label="내보내기"
              size="sm"
              onClick={() => setExportOpen(true)}
            >
              <Icon name="download" size={16} />
            </IconButton>
          )}
          {(meeting.status === "done" || meeting.status === "failed") && (
            <IconButton
              label="회의 재처리"
              size="sm"
              onClick={() => setReprocessOpen(true)}
            >
              <Icon name="rotateCcw" size={16} />
            </IconButton>
          )}
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
              speaker={meeting.speakers[a].spk}
              name={meeting.speakers[a].name}
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
        data-slot="transcript-scroll"
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onKeyDown={markUserScroll}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-6"
      >
        <VerifyBanner
          count={pendingCount}
          onResolve={() => setResolveOpen(true)}
        />
        {!aiAcked && meeting.aiCount > 0 ? (
          <AiBanner
            meeting={meeting}
            onDetail={onShowSummary}
            onAck={onAckAi}
          />
        ) : null}
        {/* role="log"는 암묵적으로 aria-live="polite"라 <mark>가 매 키 입력마다
        들고 나면 스크린리더가 타이핑 중 매칭 본문을 계속 읽는다 — 찾기용
        하이라이트는 아래 role="status" 카운터로 따로 안내하므로 여기는 끈다. */}
        <div
          className="flex flex-col gap-px"
          role="log"
          aria-label="회의 전사"
          aria-live="off"
        >
          {meeting.utterances.map((u) => {
            const failed = u.status === "transcribe_failed";
            return (
              <Utterance
                key={u.id}
                data-uid={u.id}
                tabIndex={-1}
                speaker={meeting.speakers[u.spk].spk}
                name={meeting.speakers[u.spk].name}
                time={u.t}
                active={activeBlockId === u.id}
                playing={playingId === u.id}
                quoted={u.quoted}
                placeholder={failed}
                onJump={() => onJump(u.id)}
                saved={savedIds.data?.has(u.sources[0]?.id ?? "")}
                savePending={
                  saveUtterance.isPending || removeSavedUtterance.isPending
                }
                onSaveToggle={() => {
                  const utteranceId = u.sources[0]?.id;
                  if (!utteranceId) return;
                  const mutation = savedIds.data?.has(utteranceId)
                    ? removeSavedUtterance
                    : saveUtterance;
                  const value = savedIds.data?.has(utteranceId)
                    ? utteranceId
                    : { utteranceId, text: u.text };
                  mutation.mutate(value as never, {
                    onError: (err) => {
                      if (isDemoBlocked(err)) return;
                      toast({
                        variant: "error",
                        title: "저장한 발언을 바꾸지 못했어요.",
                      });
                    },
                  });
                }}
              >
                {failed
                  ? "전사하지 못한 구간입니다"
                  : renderFindText(
                      u.text,
                      matchesByUid.get(u.id) ?? [],
                      current,
                    )}
              </Utterance>
            );
          })}
        </div>
      </div>

      {/* 찾기 바 — 회의 내 인라인 검색(브라우저 Ctrl+F 위치·조작감) */}
      <div className="flex shrink-0 items-center gap-1.5 bg-[var(--surface-card)] px-7 py-2">
        <SearchField
          ref={findInputRef}
          className="max-w-[320px] flex-1"
          placeholder="이 회의에서 찾기"
          value={query}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            // 질의를 백스페이스로 다 지웠을 때도 앵커를 초기화한다 — 안 하면
            // 같은 단어를 다시 쳤을 때 1/n이 아니라 이전 위치에서 재개된다.
            if (!next.trim()) setAnchor(null);
          }}
          onKeyDown={onFindKeyDown}
        />
        {/* 첫 값("1/3"·"결과 없음")도 스크린리더에 안내되려면 span 자체는
        질의 유무와 무관하게 항상 마운트돼 있어야 한다 — 그래야 내용 채움이
        "삽입"이 아니라 "변경"으로 잡혀 안정적으로 읽힌다. 이동 버튼은 질의가
        있을 때만 의미가 있으므로 지금처럼 조건부로 둔다. */}
        <span
          role="status"
          aria-live="polite"
          className="px-1 text-xs whitespace-nowrap text-[color:var(--text-muted)] tabular-nums"
        >
          {query.trim()
            ? matches.length
              ? `${cursor + 1}/${matches.length}`
              : "결과 없음"
            : ""}
        </span>
        {query.trim() ? (
          <>
            <IconButton
              label="이전 결과"
              size="sm"
              disabled={matches.length === 0}
              onClick={() => go(-1)}
            >
              <Icon name="chevUp" size={16} />
            </IconButton>
            <IconButton
              label="다음 결과"
              size="sm"
              disabled={matches.length === 0}
              onClick={() => go(1)}
            >
              <Icon name="chevDown" size={16} />
            </IconButton>
            <IconButton label="찾기 지우기" size="sm" onClick={clearFind}>
              <Icon name="x" size={16} />
            </IconButton>
          </>
        ) : null}
      </div>

      <RenameDialog
        meeting={meeting}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <DeleteDialog
        meeting={meeting}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={onDeleted}
      />
      <ResolveDialog
        meeting={meeting}
        open={resolveOpen}
        onOpenChange={setResolveOpen}
      />
      <ReprocessDialog
        open={reprocessOpen}
        onOpenChange={setReprocessOpen}
        meeting={{ id: meeting.id, title: meeting.title }}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        meeting={meeting}
      />
    </main>
  );
}
