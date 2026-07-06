import * as React from "react";

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
import { Input } from "@/shared/ui/input";
import { toast } from "@/shared/ui/use-toast";
import { useEnrollSpeaker } from "@/features/speaker/api/speakers";
import { toErrorMessage } from "./error";

type EnrollSpeakerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** 성문 등록 다이얼로그 — 이름 + 오디오 샘플로 새 화자를 enroll. */
export function EnrollSpeakerDialog({
  open,
  onOpenChange,
}: EnrollSpeakerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* 폼 상태는 내부 컴포넌트에 두어 다이얼로그가 열릴 때마다 초기화된다. */}
        <EnrollForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function EnrollForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const fileId = React.useId();
  const enroll = useEnrollSpeaker();

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && file !== null && !enroll.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || file === null) return;
    enroll.mutate(
      { file, name: trimmed },
      {
        onSuccess: () => {
          toast({
            title: "화자 등록을 시작했어요.",
            description: "성문 분석이 끝나면 상태가 등록됨으로 바뀌어요.",
            variant: "success",
          });
          onDone();
        },
        onError: (error) => {
          toast({
            title: "화자 등록 실패",
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
        <DialogTitle>화자 등록</DialogTitle>
        <DialogDescription>
          화자의 목소리 샘플을 등록하면 회의에서 자동으로 식별할 수 있어요.
        </DialogDescription>
      </DialogHeader>

      <Input
        label="이름"
        placeholder="예: 김지훈"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={fileId}
          className="text-sm font-medium text-[color:var(--text-secondary)]"
        >
          오디오 샘플
        </label>
        <input
          id={fileId}
          type="file"
          accept="audio/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="cursor-pointer text-sm text-[color:var(--text-secondary)] file:mr-3 file:cursor-pointer file:rounded-sm file:border-0 file:bg-[var(--gray-2)] file:px-2.5 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-[var(--gray-3)]"
        />
        <span className="text-xs text-[color:var(--text-muted)]">
          화자의 목소리가 또렷하게 담긴 파일일수록 정확해요.
        </span>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">취소</Button>
        </DialogClose>
        <Button type="submit" loading={enroll.isPending} disabled={!canSubmit}>
          등록
        </Button>
      </DialogFooter>
    </form>
  );
}
