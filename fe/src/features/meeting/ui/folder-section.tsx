import * as React from "react";

import { IconButton } from "@/shared/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { SidebarItem } from "@/shared/ui/sidebar-item";

import type { Folder, MeetingSummary } from "../model/types";
import { DeleteFolderDialog, FolderNameDialog } from "./folder-dialogs";
import { Icon } from "./icons";
import { SectionLabel } from "./section-label";

type FolderSectionProps = {
  /** 아직 못 받았거나 실패하면 undefined — 그때는 `전체 회의`만 그린다. */
  folders: Folder[] | undefined;
  meetings: MeetingSummary[];
  /** 선택한 폴더 id. null이면 `전체 회의`. */
  value: string | null;
  onChange: (folderId: string | null) => void;
};

const menuItemClass =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-[color:var(--text-secondary)] outline-none hover:bg-accent hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]";

function FolderMenu({
  folder,
  onRename,
  onDelete,
}: {
  folder: Folder;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label={`${folder.name} 폴더 메뉴`}
          size="sm"
          className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
        >
          <Icon name="more" size={15} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-36 p-1">
        <button
          type="button"
          className={menuItemClass}
          onClick={() => {
            setOpen(false);
            onRename();
          }}
        >
          <Icon name="pencil" size={14} />
          이름 바꾸기
        </button>
        <button
          type="button"
          className={`${menuItemClass} text-[color:var(--red-text)] hover:text-[color:var(--red-text)]`}
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          <Icon name="x" size={14} />
          삭제
        </button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 좌측 `폴더` 섹션. 폴더를 누르면 아래 회의 목록이 그 폴더로 걸러진다(스펙 §2.5).
 * 회의 수는 이미 받은 회의 목록에서 센다(스펙 §2.6). 오른쪽 칸(`pr-8`)은 모든 행에
 * 비워 둬서 메뉴 버튼이 있는 행과 없는 행의 숫자가 같은 줄에 선다.
 */
export function FolderSection({
  folders,
  meetings,
  value,
  onChange,
}: FolderSectionProps) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Folder | null>(null);
  const [deleting, setDeleting] = React.useState<Folder | null>(null);

  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const m of meetings)
      if (m.folderId) map.set(m.folderId, (map.get(m.folderId) ?? 0) + 1);
    return map;
  }, [meetings]);

  return (
    <>
      <SectionLabel
        action={
          folders ? (
            <IconButton
              label="새 폴더"
              size="sm"
              className="-my-1 -mr-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <Icon name="plus" size={14} />
            </IconButton>
          ) : null
        }
      >
        폴더
      </SectionLabel>
      <ul
        aria-label="폴더"
        className="flex max-h-[168px] flex-col gap-0.5 overflow-y-auto overscroll-contain"
      >
        <li>
          <SidebarItem
            icon={<Icon name="inbox" size={16} />}
            label="전체 회의"
            meta={meetings.length}
            active={value === null}
            className="pr-8"
            onClick={() => onChange(null)}
          />
        </li>
        {folders?.map((f) => (
          <li key={f.id} className="group relative">
            <SidebarItem
              icon={<Icon name="folder" size={16} />}
              label={f.name}
              meta={counts.get(f.id) ?? 0}
              active={value === f.id}
              className="pr-8"
              onClick={() => onChange(f.id)}
            />
            {!f.isDefault && (
              <FolderMenu
                folder={f}
                onRename={() => setRenaming(f)}
                onDelete={() => setDeleting(f)}
              />
            )}
          </li>
        ))}
      </ul>

      <FolderNameDialog
        open={createOpen || renaming !== null}
        folder={renaming ?? undefined}
        onOpenChange={(open) => {
          if (open) return;
          setCreateOpen(false);
          setRenaming(null);
        }}
        onSaved={(saved) => {
          if (createOpen) onChange(saved.id);
        }}
      />
      <DeleteFolderDialog
        folder={deleting}
        meetingCount={deleting ? (counts.get(deleting.id) ?? 0) : 0}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </>
  );
}
