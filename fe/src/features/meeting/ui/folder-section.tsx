import * as React from "react";

import { IconButton } from "@/shared/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { SidebarItem } from "@/shared/ui/sidebar-item";
import { cn } from "@/shared/lib/utils";

import type { Folder, MeetingSummary } from "../model/types";
import { DeleteFolderDialog, FolderNameDialog } from "./folder-dialogs";
import { Icon } from "./icons";

type FolderSectionProps = {
  /** 아직 못 받았거나 실패하면 undefined — 그때는 섹션 제목만 그린다. */
  folders: Folder[] | undefined;
  meetings: MeetingSummary[];
  /** 선택한 폴더 id. null이면 선택 없음. */
  value: string | null;
  /** 폴더 행을 눌렀거나 새 폴더를 만들었다 — 선택을 바꾸고 그 폴더 목록으로 간다. */
  onChange: (folderId: string) => void;
  /** 머리 행 `전체 회의`를 강조할지(`/meetings`에 있을 때). */
  allActive: boolean;
  onSelectAll: () => void;
};

/**
 * 이름 바로 뒤에 붙는 회의 수 칩. 오른쪽 끝은 `+`·`…` 버튼 자리라 수를 거기 두지 않는다.
 * 이름이 길면 이름만 잘리고 수는 남는다.
 */
function NameWithCount({
  name,
  count,
  active,
  className,
}: {
  name: string;
  count: number;
  active: boolean;
  className?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn("truncate", className)}>{name}</span>
      <span
        className={cn(
          "min-w-[18px] shrink-0 rounded-xs px-[5px] py-px text-center text-2xs font-medium",
          active
            ? "bg-[var(--accent-3)] text-[color:var(--accent-text)]"
            : "bg-[var(--gray-3)] text-[color:var(--text-muted)]",
        )}
      >
        {count}
      </span>
    </span>
  );
}

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
 * 좌측 폴더 섹션. 머리 행 `전체 회의`는 모든 회의 목록(`/meetings`)으로 가는 행이고, 폴더를
 * 누르면 아래 회의 목록이 그 폴더로 걸러지며 그 폴더 목록(`/folders/:id`)을 연다.
 * 머리 행은 `필터`·`회의 목록` 같은 섹션 이름표가 아니라 누를 수 있는 행이라 폴더 행과 같은
 * 크기로 그리고, 폴더 행은 한 단계 들여 써서 그 아래 놓인 것으로 읽힌다.
 * 회의 수는 이미 받은 회의 목록에서 센다(스펙 §2.6). 수는 이름 옆 칩이다. 머리 행만 항상 보이는
 * `+` 자리(`pr-8`)를 비운다 — 폴더 행의 `…`는 호버할 때만 뜨므로 긴 이름 위에 겹쳐도 된다.
 */
export function FolderSection({
  folders,
  meetings,
  value,
  onChange,
  allActive,
  onSelectAll,
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
      <div className="relative mt-3.5 mb-0.5">
        <SidebarItem
          icon={<Icon name="inbox" size={16} />}
          label={
            <NameWithCount
              name="전체 회의"
              count={meetings.length}
              active={allActive}
              className="font-semibold"
            />
          }
          active={allActive}
          className={cn("pr-8", !allActive && "text-foreground")}
          onClick={onSelectAll}
        />
        {folders ? (
          <IconButton
            label="새 폴더"
            size="sm"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="plus" size={14} />
          </IconButton>
        ) : null}
      </div>
      <ul
        aria-label="폴더"
        className="flex max-h-[168px] flex-col gap-0.5 overflow-y-auto overscroll-contain"
      >
        {folders?.map((f) => (
          <li key={f.id} className="group relative">
            <SidebarItem
              icon={<Icon name="folder" size={16} />}
              label={
                <NameWithCount
                  name={f.name}
                  count={counts.get(f.id) ?? 0}
                  active={value === f.id}
                />
              }
              active={value === f.id}
              indent={1}
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
