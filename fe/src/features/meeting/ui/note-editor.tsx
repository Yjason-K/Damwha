import * as React from "react";

import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";

import type { SaveState } from "../api/notes";
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

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  saving: "저장 중",
  saved: "저장됨",
  error: "저장 실패",
};

export type NoteEditorProps = {
  /** 현재 본문(마크다운 원문). */
  body: string;
  /** 본문이 바뀔 때. 툴바·단축키도 이 콜백으로 새 본문을 넘긴다. */
  onChange: (next: string) => void;
  isLoading?: boolean;
  isError?: boolean;
  /** 저장 상태 표시줄. 생략하면 아무것도 그리지 않는다(`idle`과 같다). */
  saveState?: SaveState;
  /** 편집을 끝낼 때 — 대기 중인 저장을 밀어내는 쪽이 붙인다. */
  onDone?: () => void;
  /** 저장 실패 후 재시도. */
  onRetrySave?: () => void;
  /** 조회 실패 후 다시 불러오기. */
  onReload?: () => void;
};

/**
 * 마크다운 메모 편집기 — 읽기모드와 편집모드를 오간다. 렌더된 문서를 클릭하는
 * 것만으로 편집이 시작되면 문서 안의 링크·체크박스와 편집 진입이 섞이므로,
 * 모드 전환은 명시적인 버튼으로만 일어난다.
 *
 * 데이터를 모른다 — 본문과 상태를 props로 받기만 하므로 서버에 붙은
 * `NotePane`과 `/showcase`의 로컬 상태 데모가 같은 컴포넌트를 쓴다.
 * (`InsightPane`이 presentational로 유지되는 것과 같은 이유다.)
 */
export function NoteEditor({
  body,
  onChange,
  isLoading = false,
  isError = false,
  saveState = "idle",
  onDone,
  onRetrySave,
  onReload,
}: NoteEditorProps) {
  const [editing, setEditing] = React.useState(false);
  const boxRef = React.useRef<HTMLTextAreaElement | null>(null);

  const done = React.useCallback(() => {
    onDone?.();
    setEditing(false);
  }, [onDone]);

  const apply = React.useCallback(
    (command: Command) => {
      const box = boxRef.current;
      if (!box) return;
      const next = command.run({
        text: box.value,
        start: box.selectionStart,
        end: box.selectionEnd,
      });
      onChange(next.text);
      // 값이 리렌더로 반영된 뒤에 선택을 복원해야 커서가 끝으로 튀지 않는다.
      requestAnimationFrame(() => {
        box.focus();
        box.setSelectionRange(next.start, next.end);
      });
    },
    [onChange],
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

  // 조회 자체가 실패했을 때는 편집을 열지 않는다 — 여기서 편집을 허용하면
  // 사용자가 진짜 메모 위에 빈 화면을 덧쓰고, 저장이 그 진짜 메모를
  // 지워 버린다. "메모 없음"과 "불러오기 실패"는 반드시 다른 화면이어야 한다.
  if (isError) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <Icon name="x" size={20} className="text-[color:var(--text-faint)]" />
        <p className="text-sm text-[color:var(--text-muted)]">
          메모를 불러오지 못했어요.
        </p>
        <Button variant="secondary" size="sm" onClick={onReload}>
          다시 시도
        </Button>
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
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
        className="min-h-64 w-full resize-y rounded-sm border border-border bg-[var(--surface-app)] p-2 font-mono text-sm leading-relaxed text-foreground outline-none focus-visible:border-[color:var(--border-focus)] focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)]"
      />

      <div className="flex items-center justify-between gap-2">
        <span
          className="text-2xs text-[color:var(--text-faint)]"
          role="status"
          aria-live="polite"
        >
          {SAVE_LABEL[saveState]}
        </span>
        <div className="flex items-center gap-1">
          {saveState === "error" ? (
            <Button variant="secondary" size="sm" onClick={onRetrySave}>
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
