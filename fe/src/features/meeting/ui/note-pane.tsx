import * as React from "react";

import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";

import { useAutosaveNote } from "../api/notes";
import {
  insertLink,
  toggleLinePrefix,
  toggleWrap,
  type Selection,
} from "../lib/md-commands";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./markdown";

type Command = {
  label: string;
  icon: IconName;
  run: (sel: Selection) => Selection;
};

const COMMANDS: Command[] = [
  { label: "굵게", icon: "bold", run: (s) => toggleWrap(s, "**") },
  { label: "기울임", icon: "italic", run: (s) => toggleWrap(s, "*") },
  { label: "제목", icon: "heading", run: (s) => toggleLinePrefix(s, "## ") },
  { label: "목록", icon: "bulletList", run: (s) => toggleLinePrefix(s, "- ") },
  {
    label: "체크박스",
    icon: "checkSquare",
    run: (s) => toggleLinePrefix(s, "- [ ] "),
  },
  { label: "링크", icon: "link", run: insertLink },
  { label: "코드", icon: "code", run: (s) => toggleWrap(s, "`") },
];

const SAVE_LABEL: Record<string, string> = {
  idle: "",
  saving: "저장 중",
  saved: "저장됨",
  error: "저장 실패",
};

/**
 * 인사이트 레일의 메모 탭. 읽기모드와 편집모드를 오간다 — 렌더된 문서를
 * 클릭하는 것만으로 편집이 시작되면 문서 안의 링크·체크박스와 편집 진입이
 * 섞인다.
 */
export function NotePane({ meetingId }: { meetingId: string }) {
  const { body, isLoading, state, change, flush, retry } =
    useAutosaveNote(meetingId);
  const [editing, setEditing] = React.useState(false);
  const boxRef = React.useRef<HTMLTextAreaElement | null>(null);

  // 회의가 바뀌면 이전 회의에서 편집 중이었어도 새 회의는 읽기모드로 보여야
  // 한다. setState는 effect가 아니라 렌더 중에 조정한다 — `notes.ts`의
  // draft 리셋과 같은 패턴이라 react-hooks/set-state-in-effect에 걸리지 않는다.
  const [prevMeetingId, setPrevMeetingId] = React.useState(meetingId);
  if (prevMeetingId !== meetingId) {
    setPrevMeetingId(meetingId);
    setEditing(false);
  }

  const done = React.useCallback(() => {
    flush();
    setEditing(false);
  }, [flush]);

  const apply = React.useCallback(
    (command: Command) => {
      const box = boxRef.current;
      if (!box) return;
      const next = command.run({
        text: box.value,
        start: box.selectionStart,
        end: box.selectionEnd,
      });
      change(next.text);
      // 값이 리렌더로 반영된 뒤에 선택을 복원해야 커서가 끝으로 튀지 않는다.
      requestAnimationFrame(() => {
        box.focus();
        box.setSelectionRange(next.start, next.end);
      });
    },
    [change],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      done();
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      done();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "b") {
      event.preventDefault();
      apply(COMMANDS[0]);
    }
    if (key === "i") {
      event.preventDefault();
      apply(COMMANDS[1]);
    }
  };

  if (isLoading) {
    return (
      <div className="px-4 py-10 text-center" role="status" aria-busy="true">
        <p className="text-sm text-[color:var(--text-muted)]">
          메모를 불러오는 중…
        </p>
      </div>
    );
  }

  if (!editing) {
    if (body.trim().length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <Icon
            name="pencil"
            size={20}
            className="text-[color:var(--text-faint)]"
          />
          <p className="text-sm text-[color:var(--text-muted)]">
            아직 메모가 없어요.
          </p>
          <p className="text-xs text-[color:var(--text-faint)]">
            회의 중 남긴 메모가 여기에 모여요.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing(true)}
          >
            메모 쓰기
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center justify-end">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            편집
          </Button>
        </div>
        <Markdown body={body} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border pb-2">
        {COMMANDS.map((command) => (
          <IconButton
            key={command.label}
            size="sm"
            label={command.label}
            onClick={() => apply(command)}
          >
            <Icon name={command.icon} size={15} />
          </IconButton>
        ))}
      </div>

      <textarea
        ref={boxRef}
        aria-label="메모 본문"
        value={body}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
        className="min-h-64 w-full resize-y rounded-sm border border-border bg-[var(--surface-app)] p-2 font-mono text-sm leading-relaxed text-foreground outline-none focus-visible:border-primary"
      />

      <div className="flex items-center justify-between gap-2">
        <span
          className="text-2xs text-[color:var(--text-faint)]"
          role="status"
          aria-live="polite"
        >
          {SAVE_LABEL[state]}
        </span>
        <div className="flex items-center gap-1">
          {state === "error" ? (
            <Button variant="secondary" size="sm" onClick={retry}>
              다시 시도
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={done}>
            완료
          </Button>
        </div>
      </div>
    </div>
  );
}
