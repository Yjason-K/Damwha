import * as React from "react";

import { isApiError } from "@/shared/api/client";
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
import { toast } from "@/shared/ui/use-toast";
import { Utterance } from "@/shared/ui/utterance";

import {
  useDeleteMeeting,
  useRenameMeeting,
  useToggleFavorite,
} from "../api/meetings";
import type { Meeting } from "../model/types";
import { Icon } from "./icons";
import { ReprocessDialog } from "./reprocess-dialog";
import { ResolveDialog } from "./resolve-dialog";

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
        onError: (err) =>
          toast({
            variant: "error",
            title: "이름 변경에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          }),
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
        onError: (err) =>
          toast({
            variant: "error",
            title: "삭제에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          }),
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

type TranscriptPaneProps = {
  meeting: Meeting;
  activeId: string;
  onJump: (uid: string) => void;
  onDeleted: () => void;
  aiAcked: boolean;
  onAckAi: () => void;
  onShowSummary: () => void;
};

export function TranscriptPane({
  meeting,
  activeId,
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

  const favorite = useToggleFavorite();
  const fav = !!meeting.fav;
  const toggleFav = () =>
    favorite.mutate(
      { id: meeting.id, fav: !fav },
      {
        onError: (err) =>
          toast({
            variant: "error",
            title: "즐겨찾기 변경에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          }),
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
        <div className="flex flex-col gap-px" role="log" aria-label="회의 전사">
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
                quoted={u.quoted}
                placeholder={failed}
                onJump={() => onJump(u.id)}
              >
                {failed ? "전사하지 못한 구간입니다" : u.text}
              </Utterance>
            );
          })}
        </div>
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
    </main>
  );
}
