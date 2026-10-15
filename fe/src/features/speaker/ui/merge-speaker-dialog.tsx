import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { toast } from "@/shared/ui/use-toast";
import {
  useMergeSpeaker,
  useSpeakers,
  type SpeakerItem,
} from "@/features/speaker/api/speakers";
import { toErrorMessage } from "./error";

type MergeSpeakerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  speaker: SpeakerItem;
};

/**
 * 화자 병합 다이얼로그. 이 화자를 기존 화자에 합친다 — 발화와 목소리가 고른 화자로 옮겨 가고
 * 이 화자는 사라진다. 서버가 받는 대상(ready/provisional)만 고를 수 있고, 워커가 남긴
 * 후보(`suggestion`)가 있으면 미리 골라 둔다.
 */
export function MergeSpeakerDialog({
  open,
  onOpenChange,
  speaker,
}: MergeSpeakerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <MergeForm speaker={speaker} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MergeForm({
  speaker,
  onDone,
}: {
  speaker: SpeakerItem;
  onDone: () => void;
}) {
  const speakers = useSpeakers();
  const merge = useMergeSpeaker();
  const targets = (speakers.data ?? []).filter(
    (s) =>
      s.id !== speaker.id &&
      (s.status === "ready" || s.status === "provisional"),
  );
  const [into, setInto] = React.useState(speaker.suggestion?.id ?? "");
  const target = targets.find((s) => s.id === into);
  const canSubmit = target != null && !merge.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    merge.mutate(
      { id: speaker.id, into: target.id },
      {
        onSuccess: () => {
          toast({
            title: `${speaker.name}을(를) ${target.name}에 합쳤어요.`,
            variant: "success",
          });
          onDone();
        },
        onError: (error) => {
          if (isDemoBlocked(error)) return;
          toast({
            title: "병합하지 못했어요",
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
        <DialogTitle>기존 화자로 병합</DialogTitle>
        <DialogDescription>
          {speaker.name}의 발화와 목소리를 고른 화자로 옮기고, {speaker.name}은
          목록에서 사라져요. 다음 회의부터는 고른 화자로 알아봐요.
        </DialogDescription>
      </DialogHeader>

      <Select value={into} onValueChange={setInto}>
        <SelectTrigger aria-label="합칠 화자">
          <SelectValue placeholder="합칠 화자를 고르세요" />
        </SelectTrigger>
        <SelectContent>
          {targets.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
              {s.id === speaker.suggestion?.id
                ? ` · 추천 ${Math.round(speaker.suggestion.similarity * 100)}%`
                : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">취소</Button>
        </DialogClose>
        <Button type="submit" loading={merge.isPending} disabled={!canSubmit}>
          병합
        </Button>
      </DialogFooter>
    </form>
  );
}
