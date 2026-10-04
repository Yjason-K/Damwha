import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { toast } from "@/shared/ui/use-toast";

import { useFolders } from "../api/folders";
import { useMoveMeetingToFolder } from "../api/meetings";
import { Icon } from "./icons";

export function MeetingFolder({
  meetingId,
  folderId,
}: {
  meetingId: string;
  folderId: string | null;
}) {
  const { data: folders } = useFolders();
  const move = useMoveMeetingToFolder();
  const [open, setOpen] = React.useState(false);
  const current = folders?.find((f) => f.id === folderId);
  if (!folders || !current) return null;

  const pick = (id: string) => {
    setOpen(false);
    if (id === folderId) return;
    move.mutate(
      { id: meetingId, folderId: id },
      {
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "폴더를 옮기지 못했어요",
            description: isApiError(err)
              ? err.message
              : "잠시 후 다시 시도해 주세요.",
          });
        },
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`폴더: ${current.name} (옮기기)`}
          disabled={move.isPending}
          className="-mx-1 inline-flex min-w-0 cursor-pointer items-center gap-[5px] rounded-xs px-1 whitespace-nowrap outline-none hover:bg-accent hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-default disabled:opacity-60"
        >
          <Icon name="folder" size={14} />
          <span className="truncate">{current.name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-64 w-52 overflow-y-auto p-1">
        <ul aria-label="옮길 폴더">
          {folders.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                aria-current={f.id === folderId || undefined}
                onClick={() => pick(f.id)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-[color:var(--text-secondary)] outline-none hover:bg-accent hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]"
              >
                <Icon name="folder" size={14} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {f.id === folderId && (
                  <Icon
                    name="check"
                    size={14}
                    className="text-[color:var(--accent-text)]"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
