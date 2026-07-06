import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { toast } from "@/shared/ui/use-toast";
import {
  useRenameSpeaker,
  type SpeakerItem,
} from "@/features/speaker/api/speakers";
import { toErrorMessage } from "./error";

type RenameSpeakerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  speaker: SpeakerItem;
};

/** 화자 이름 변경 다이얼로그. provisional 화자는 이름 변경 시 등록됨으로 승격된다. */
export function RenameSpeakerDialog({
  open,
  onOpenChange,
  speaker,
}: RenameSpeakerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* 폼 상태는 내부 컴포넌트에 두어 열릴 때마다 현재 이름으로 초기화된다. */}
        <RenameForm speaker={speaker} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  speaker,
  onDone,
}: {
  speaker: SpeakerItem;
  onDone: () => void;
}) {
  const [name, setName] = React.useState(speaker.name);
  const rename = useRenameSpeaker();

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !rename.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    rename.mutate(
      { id: speaker.id, name: trimmed },
      {
        onSuccess: () => {
          toast({ title: "이름을 변경했어요.", variant: "success" });
          onDone();
        },
        onError: (error) => {
          toast({
            title: "이름 변경 실패",
            description: toErrorMessage(error),
            variant: "error",
          });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>이름 변경</DialogTitle>
      </DialogHeader>

      <Input
        label="이름"
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint={
          speaker.status === "provisional"
            ? "이름을 저장하면 이 화자가 등록됨으로 확정돼요."
            : undefined
        }
        autoFocus
      />

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">취소</Button>
        </DialogClose>
        <Button type="submit" loading={rename.isPending} disabled={!canSubmit}>
          변경
        </Button>
      </DialogFooter>
    </form>
  );
}
