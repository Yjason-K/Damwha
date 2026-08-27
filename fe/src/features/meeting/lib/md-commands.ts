/**
 * 툴바 명령 — textarea의 (본문, 선택 시작, 선택 끝)을 받아 새 상태를 돌려주는
 * 순수 함수. DOM도 React도 모르므로 테스트가 값 비교로 끝나고, 나중에 "발언
 * 링크 삽입" 같은 명령을 더할 자리도 여기다.
 */
export type Selection = { text: string; start: number; end: number };

/** `**굵게**`, `*기울임*`, `` `코드` `` 처럼 선택 영역을 마커로 감싸거나 벗긴다. */
export function toggleWrap(sel: Selection, marker: string): Selection {
  const { text, start, end } = sel;
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  if (before.endsWith(marker) && after.startsWith(marker)) {
    const head = before.slice(0, before.length - marker.length);
    return {
      text: head + selected + after.slice(marker.length),
      start: head.length,
      end: head.length + selected.length,
    };
  }

  const text2 = `${before}${marker}${selected}${marker}${after}`;
  const start2 = start + marker.length;
  return { text: text2, start: start2, end: start2 + selected.length };
}

/**
 * `- `, `- [ ] `, `## ` 처럼 줄 단위 접두사를 토글한다. 선택이 걸친 모든
 * (비어 있지 않은) 줄이 이미 접두사를 가질 때만 벗기고, 아니면 전부 붙인다 —
 * 섞인 상태에서 벗기면 사용자가 방금 만든 목록이 반쯤 풀린다.
 */
export function toggleLinePrefix(sel: Selection, prefix: string): Selection {
  const { text, start, end } = sel;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;

  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const targets = lines.filter((line) => line.trim().length > 0);
  const stripping =
    targets.length > 0 && targets.every((line) => line.startsWith(prefix));

  const next = lines
    .map((line) => {
      if (line.trim().length === 0) return line;
      return stripping ? line.slice(prefix.length) : prefix + line;
    })
    .join("\n");

  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + next.length,
  };
}

const LINK_TEXT_PLACEHOLDER = "텍스트";
const LINK_URL_PLACEHOLDER = "url";

/**
 * `[텍스트](url)`을 넣는다. 선택이 있으면 그것을 링크 텍스트로 삼고 커서를
 * url 자리에, 없으면 텍스트 자리에 둔다 — 어느 쪽이든 바로 타이핑하면 된다.
 */
export function insertLink(sel: Selection): Selection {
  const { text, start, end } = sel;
  const selected = text.slice(start, end);
  const label = selected.length > 0 ? selected : LINK_TEXT_PLACEHOLDER;
  const snippet = `[${label}](${LINK_URL_PLACEHOLDER})`;
  const next = text.slice(0, start) + snippet + text.slice(end);

  const cursor =
    selected.length > 0
      ? start + label.length + 3 // "[label](" 다음 = url 시작
      : start + 1; // "[" 다음 = 텍스트 시작
  const length =
    selected.length > 0 ? LINK_URL_PLACEHOLDER.length : label.length;
  return { text: next, start: cursor, end: cursor + length };
}
