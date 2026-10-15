import * as React from "react";
import { Link } from "react-router";

import { Avatar } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { IconButton } from "@/shared/ui/icon-button";
import { Icon } from "@/features/meeting/ui/icons";
import {
  useClearMe,
  useSetMe,
  type SpeakerItem,
} from "@/features/speaker/api/speakers";
import { SpeakerStatusBadge } from "./speaker-status-badge";
import { RenameSpeakerDialog } from "./rename-speaker-dialog";
import { DeleteSpeakerDialog } from "./delete-speaker-dialog";
import { MergeSpeakerDialog } from "./merge-speaker-dialog";

type SpeakerRowProps = {
  speaker: SpeakerItem;
  /** 아바타 틴트(1–8, 목록 등장 순서 기준). */
  tint: number;
  /** 이 행의 미리듣기가 재생 중인지 — 재생은 목록이 하나로 관리한다. */
  playing: boolean;
  onToggleSample: () => void;
};

/** 재생/정지 글리프. 목록 안에서만 쓰여 features/meeting의 Icon을 끌어오지 않는다. */
function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {playing ? (
        <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M6 3.5v9M10 3.5v9" />
        </g>
      ) : (
        <path fill="currentColor" d="M5.5 3.4v9.2l7.2-4.6z" />
      )}
    </svg>
  );
}

/** ISO 문자열 → "2026.07.03" 표시용. */
function formatDate(iso: string): string {
  return iso.slice(0, 10).replaceAll("-", ".");
}

const MAX_MEETING_LINKS = 2;

function MeetingLinks({ meetings }: { meetings: SpeakerItem["meetings"] }) {
  if (meetings.length === 0) {
    return <span>등장한 회의가 없어요</span>;
  }
  const shown = meetings.slice(0, MAX_MEETING_LINKS);
  const rest = meetings.length - shown.length;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="shrink-0">등장:</span>
      {shown.map((m, i) => (
        <React.Fragment key={m.id}>
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          <Link
            to={`/meetings/${m.id}`}
            className="min-w-0 truncate rounded-xs text-[color:var(--text-link)] no-underline outline-none hover:underline focus-visible:[box-shadow:var(--focus-ring)]"
          >
            {m.title ?? "제목 없는 회의"}
          </Link>
        </React.Fragment>
      ))}
      {rest > 0 ? <span className="shrink-0">외 {rest}개</span> : null}
    </span>
  );
}

/**
 * 화자 목록의 한 행. 확인 필요(provisional) 화자는 등록일 대신 등장한 회의를 링크로 보이고,
 * 워커가 남긴 후보가 있으면 "OO일 수 있어요"와 병합 버튼을 바로 낸다. 나머지 동작은 더보기
 * 메뉴 하나로 접는다 — 모든 행에 `나로 지정 / 이름 변경 / 삭제`가 반복되던 것을 UX 리뷰
 * (2026-10-15)에서 고쳤다.
 */
export function SpeakerRow({
  speaker,
  tint,
  playing,
  onToggleSample,
}: SpeakerRowProps) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const needsReview = speaker.status === "provisional";
  const setMe = useSetMe();
  const clearMe = useClearMe();

  return (
    <Card padding="sm" className="flex items-center gap-3">
      <Avatar name={speaker.name} speaker={tint} size="lg" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-medium text-foreground">
            {speaker.name}
          </span>
          {speaker.isMe ? <Badge variant="accent">나</Badge> : null}
          <SpeakerStatusBadge status={speaker.status} />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-sm text-[color:var(--text-muted)]">
          {needsReview ? (
            <MeetingLinks meetings={speaker.meetings} />
          ) : (
            <span>{formatDate(speaker.createdAt)} 등록</span>
          )}
        </div>
        {needsReview && speaker.suggestion ? (
          <p className="mt-1 text-sm text-foreground">
            {`${speaker.suggestion.name}일 수 있어요`}
            <span className="ml-1.5 text-xs text-[color:var(--text-muted)]">
              유사도 {Math.round(speaker.suggestion.similarity * 100)}%
            </span>
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {speaker.sample ? (
          <IconButton
            size="sm"
            label={
              playing
                ? `${speaker.name} 미리듣기 정지`
                : `${speaker.name} 목소리 듣기`
            }
            pressed={playing}
            onClick={onToggleSample}
          >
            <PlayIcon playing={playing} />
          </IconButton>
        ) : null}
        {needsReview ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setMergeOpen(true)}
          >
            {speaker.suggestion
              ? `${speaker.suggestion.name}에 병합`
              : "기존 화자로 병합"}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" label={`${speaker.name} 더보기`}>
              <Icon name="more" size={16} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {needsReview ? null : (
              <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
                다른 화자로 병합
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              {needsReview ? "새 사람으로 이름 짓기" : "이름 변경"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={setMe.isPending || clearMe.isPending}
              onSelect={() =>
                (speaker.isMe ? clearMe : setMe).mutate({ id: speaker.id })
              }
            >
              {speaker.isMe ? "나 지정 해제" : "나로 지정"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleteOpen(true)}
            >
              삭제
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <RenameSpeakerDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        speaker={speaker}
      />
      <MergeSpeakerDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        speaker={speaker}
      />
      <DeleteSpeakerDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        speaker={speaker}
      />
    </Card>
  );
}
