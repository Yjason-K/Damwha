import { describe, expect, it } from "vitest";

import { insertLink, toggleLinePrefix, toggleWrap } from "./md-commands";

describe("toggleWrap", () => {
  it("선택 영역을 마커로 감싸고 선택을 유지한다", () => {
    const out = toggleWrap({ text: "배포는 다음 주", start: 0, end: 3 }, "**");
    expect(out.text).toBe("**배포는** 다음 주");
    expect(out.text.slice(out.start, out.end)).toBe("배포는");
  });

  it("이미 감싸져 있으면 벗긴다", () => {
    const out = toggleWrap(
      { text: "**배포는** 다음 주", start: 2, end: 5 },
      "**",
    );
    expect(out.text).toBe("배포는 다음 주");
    expect(out.text.slice(out.start, out.end)).toBe("배포는");
  });

  it("선택이 없으면 마커만 넣고 커서를 그 사이에 둔다", () => {
    const out = toggleWrap({ text: "", start: 0, end: 0 }, "**");
    expect(out.text).toBe("****");
    expect(out.start).toBe(2);
    expect(out.end).toBe(2);
  });
});

describe("toggleLinePrefix", () => {
  it("커서가 놓인 줄에 접두사를 붙인다", () => {
    const out = toggleLinePrefix(
      { text: "첫 줄\n둘째 줄", start: 7, end: 7 },
      "- ",
    );
    expect(out.text).toBe("첫 줄\n- 둘째 줄");
  });

  it("선택이 걸친 모든 줄에 붙인다", () => {
    const out = toggleLinePrefix({ text: "가\n나", start: 0, end: 3 }, "- ");
    expect(out.text).toBe("- 가\n- 나");
  });

  it("걸친 줄이 모두 접두사를 가지면 벗긴다", () => {
    const out = toggleLinePrefix(
      { text: "- 가\n- 나", start: 0, end: 7 },
      "- ",
    );
    expect(out.text).toBe("가\n나");
  });

  it("일부만 가진 경우는 붙이는 쪽으로 통일한다", () => {
    const out = toggleLinePrefix({ text: "- 가\n나", start: 0, end: 5 }, "- ");
    expect(out.text).toBe("- - 가\n- 나");
  });

  it("빈 줄은 건드리지 않는다", () => {
    const out = toggleLinePrefix({ text: "가\n\n나", start: 0, end: 4 }, "- ");
    expect(out.text).toBe("- 가\n\n- 나");
  });
});

describe("insertLink", () => {
  it("선택을 링크 텍스트로 쓰고 url 자리를 선택해 둔다", () => {
    const out = insertLink({ text: "담화 문서", start: 0, end: 2 });
    expect(out.text).toBe("[담화](url) 문서");
    expect(out.text.slice(out.start, out.end)).toBe("url");
  });

  it("선택이 없으면 빈 링크를 넣고 텍스트 자리를 선택한다", () => {
    const out = insertLink({ text: "", start: 0, end: 0 });
    expect(out.text).toBe("[텍스트](url)");
    expect(out.text.slice(out.start, out.end)).toBe("텍스트");
  });
});
