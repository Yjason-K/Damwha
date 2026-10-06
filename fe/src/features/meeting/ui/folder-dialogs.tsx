import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
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

import {
  useCreateFolder,
  useDeleteFolder,
  useRenameFolder,
} from "../api/folders";
import type { Folder } from "../model/types";

const MAX_NAME_LENGTH = 30;

type FolderNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 있으면 이름 바꾸기, 없으면 새 폴더 만들기. */
  folder?: Folder;
  onSaved?: (folder: Folder) => void;
};

export function FolderNameDialog({
  open,
  onOpenChange,
  folder,
  onSaved,
}: FolderNameDialogProps) {
  const create = useCreateFolder();
  const rename = useRenameFolder();
  const pending = create.isPending || rename.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        {/* DialogContent는 닫히면 언마운트된다 — 열 때마다 폼 상태가 새로 시작한다. */}
        <FolderNameForm
          folder={folder}
          pending={pending}
          onSubmit={(name, onConflict) => {
            const options = {
              onSuccess: (saved: Folder) => {
                onOpenChange(false);
                onSaved?.(saved);
              },
              onError: (err: unknown) => {
                if (isDemoBlocked(err)) return;
                if (isApiError(err) && err.statusCode === 409) {
                  onConflict();
                  return;
                }
                toast({
                  variant: "error",
                  title: "폴더를 저장하지 못했어요",
                  description: isApiError(err)
                    ? err.message
                    : "잠시 후 다시 시도해 주세요.",
                });
              },
            };
            if (folder) rename.mutate({ id: folder.id, name }, options);
            else create.mutate({ name }, options);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function FolderNameForm({
  folder,
  pending,
  onSubmit,
}: {
  folder?: Folder;
  pending: boolean;
  onSubmit: (name: string, onConflict: () => void) => void;
}) {
  const [name, setName] = React.useState(folder?.name ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const trimmed = name.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || pending) return;
    onSubmit(trimmed, () => setError("같은 이름의 폴더가 있어요."));
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{folder ? "폴더 이름 바꾸기" : "새 폴더"}</DialogTitle>
        <DialogDescription>
          회의는 폴더 하나에 들어가요. 프로젝트나 팀처럼 겹치지 않는 묶음에
          쓰세요.
        </DialogDescription>
      </DialogHeader>
      <Input
        label="폴더 이름"
        autoFocus
        maxLength={MAX_NAME_LENGTH}
        value={name}
        error={error ?? undefined}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
      />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="secondary" disabled={pending}>
            취소
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!trimmed} loading={pending}>
          {folder ? "저장" : "만들기"}
        </Button>
      </DialogFooter>
    </form>
  );
}

type DeleteFolderDialogProps = {
  folder: Folder | null;
  meetingCount: number;
  onOpenChange: (open: boolean) => void;
};

/** 폴더 삭제 확인. 안의 회의는 지워지지 않고 서버가 기본 폴더로 옮긴다. */
export function DeleteFolderDialog({
  folder,
  meetingCount,
  onOpenChange,
}: DeleteFolderDialogProps) {
  const del = useDeleteFolder();

  const submit = () => {
    if (!folder) return;
    del.mutate(
      { id: folder.id },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "폴더를 지우지 못했어요",
            description: isApiError(err)
              ? err.message
              : "잠시 후 다시 시도해 주세요.",
          });
        },
      },
    );
  };

  return (
    <Dialog
      open={folder !== null}
      onOpenChange={(next) => !del.isPending && onOpenChange(next)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>폴더 삭제</DialogTitle>
          <DialogDescription>
            ‘{folder?.name}’ 폴더를 지울까요?
            {meetingCount > 0
              ? ` 안에 있던 회의 ${meetingCount}개는 기본 폴더로 옮겨져요.`
              : " 비어 있는 폴더예요."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary" disabled={del.isPending}>
              취소
            </Button>
          </DialogClose>
          <Button variant="danger" onClick={submit} loading={del.isPending}>
            삭제
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
