import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Kbd } from "@/shared/ui/kbd";
import { toast } from "@/shared/ui/use-toast";

import { Icon } from "./icons";

type MeetingDropzoneProps = {
  /** 회의가 이미 있으면 한 줄짜리로 줄인다. 비어 있으면 빈 상태를 대신한다. */
  compact: boolean;
  onFile: (file: File) => void;
  onRecord: () => void;
};

const isAudio = (file: File) => file.type.startsWith("audio/");

/**
 * 회의 목록 위의 녹음 파일 드롭존. 파일을 놓거나 고르면 바로 올리지 않고 `onFile`로
 * 넘긴다 — 새 회의 모달이 그 파일을 채운 채 열려 옵션을 고른 뒤 올린다. `⌥U`는 파일
 * 선택 창을 연다(입력 중이거나 모달이 열려 있으면 가로채지 않는다).
 */
export function MeetingDropzone({
  compact,
  onFile,
  onRecord,
}: MeetingDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const accept = (file: File | undefined) => {
    if (!file) return;
    if (!isAudio(file)) {
      toast({
        variant: "error",
        title: "오디오 파일만 올릴 수 있어요",
        description: file.name,
      });
      return;
    }
    onFile(file);
  };

  const pickFile = React.useEffectEvent(() => inputRef.current?.click());
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyU" || !e.altKey) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.isComposing) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.closest("input, textarea, select"))
      )
        return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      pickFile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  return (
    <section
      aria-label="녹음 파일 올리기"
      data-dragging={dragging || undefined}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        accept(e.dataTransfer.files[0]);
      }}
      className={cn(
        "rounded-md border border-dashed border-[color:var(--border-strong)] bg-[var(--surface-sunken)] transition-[border-color,background-color] duration-[var(--dur-instant)] ease-[var(--ease-standard)]",
        dragging && "border-[color:var(--accent-text)] bg-[var(--accent-bg)]",
        compact
          ? "flex items-center gap-3 px-4 py-3"
          : "flex flex-col items-center gap-3 px-6 py-12 text-center",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md border border-border bg-card text-foreground",
          compact ? "size-9" : "mb-1 size-14",
        )}
      >
        <Icon name="waveform" size={compact ? 18 : 26} />
      </span>
      <div className={cn("min-w-0", compact && "flex-1")}>
        <p
          className={cn(
            "font-semibold text-foreground",
            compact ? "text-sm" : "text-h2",
          )}
        >
          회의 녹음 파일을 이곳에 끌어다 놓으세요
        </p>
        <p
          className={cn(
            "text-[color:var(--text-muted)]",
            compact ? "text-xs" : "mt-1 text-sm",
          )}
        >
          m4a, mp3, wav 등 오디오 파일 · 놓으면 옵션을 고른 뒤 올려요
        </p>
      </div>
      <div className={cn("flex items-center gap-2", !compact && "mt-2")}>
        <Button
          type="button"
          size={compact ? "sm" : "md"}
          iconLeft={<Icon name="plus" size={15} />}
          onClick={() => inputRef.current?.click()}
        >
          파일 선택하기
          <Kbd
            aria-label="단축키 Option U"
            className="ml-1 border-transparent bg-transparent text-[color:var(--text-on-accent)] opacity-70"
          >
            ⌥U
          </Kbd>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size={compact ? "sm" : "md"}
          onClick={onRecord}
        >
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-[var(--red-9)]"
          />
          실시간 녹음 시작
          <span className="ml-1 font-mono text-2xs tracking-[var(--tracking-mono)] text-[color:var(--text-faint)]">
            REC
          </span>
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        data-testid="dropzone-file-input"
        onChange={(e) => {
          accept(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </section>
  );
}
