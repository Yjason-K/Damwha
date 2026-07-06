import * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { SpeakerItem } from "@/features/speaker/api/speakers";
import { SpeakerStatusBadge } from "./speaker-status-badge";
import { RenameSpeakerDialog } from "./rename-speaker-dialog";
import { DeleteSpeakerDialog } from "./delete-speaker-dialog";

type SpeakerRowProps = {
  speaker: SpeakerItem;
  /** 아바타 틴트(1–8, 목록 등장 순서 기준). */
  tint: number;
};

/** ISO 문자열 → "2026.07.03" 표시용. */
function formatDate(iso: string): string {
  return iso.slice(0, 10).replaceAll("-", ".");
}

/** 화자 목록의 한 행 — 아바타/이름/상태/등록일 + 이름 변경·삭제 액션. */
export function SpeakerRow({ speaker, tint }: SpeakerRowProps) {
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
