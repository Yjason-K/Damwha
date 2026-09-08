import * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { IconButton } from "@/shared/ui/icon-button";
import type { SpeakerItem } from "@/features/speaker/api/speakers";
import { SpeakerStatusBadge } from "./speaker-status-badge";
import { RenameSpeakerDialog } from "./rename-speaker-dialog";
import { DeleteSpeakerDialog } from "./delete-speaker-dialog";

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

/** 화자 목록의 한 행 — 아바타/이름/상태/등록일 + 미리듣기·이름 변경·삭제 액션. */
export function SpeakerRow({
  speaker,
  tint,
  playing,
  onToggleSample,
}: SpeakerRowProps) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  return (
    <Card padding="sm" className="flex items-center gap-3">
      <Avatar name={speaker.name} speaker={tint} size="lg" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-medium text-foreground">
            {speaker.name}
          </span>
          <SpeakerStatusBadge status={speaker.status} />
        </div>
        <p className="mt-0.5 text-sm text-[color:var(--text-muted)]">
          {formatDate(speaker.createdAt)} 등록
        </p>
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
        <Button variant="ghost" size="sm" onClick={() => setRenameOpen(true)}>
          이름 변경
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)}>
          삭제
        </Button>
      </div>

      <RenameSpeakerDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
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
