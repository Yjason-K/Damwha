import { describe, expect, it } from "vitest";
import {
  currentDialogOptions,
  failedDialogOptions,
  failureMessage,
  NEWER_BUTTONS,
  newerChoice,
  newerDialogOptions,
} from "../../src/update/dialogs";

describe("newerDialogOptions", () => {
  it("열기가 기본이고 Escape는 나중에다 (스펙 §3-11)", () => {
    const o = newerDialogOptions("0.3.1", "0.4.0");
    expect(o.buttons).toEqual([...NEWER_BUTTONS]);
    expect(o.defaultId).toBe(0);
    expect(o.cancelId).toBe(1);
    expect(o.message).toBe("새 버전 0.4.0이 나왔어요");
    expect(o.detail).toContain("0.3.1");
  });
});

describe("newerChoice", () => {
  it("버튼 번호를 선택으로 바꾸고 모르는 번호는 나중에다", () => {
    expect(newerChoice(0)).toBe("open");
    expect(newerChoice(1)).toBe("later");
    expect(newerChoice(2)).toBe("skip");
    expect(newerChoice(-1)).toBe("later");
    expect(newerChoice(7)).toBe("later");
  });
});

describe("정보 대화상자", () => {
  it("최신·실패는 확인 버튼 하나", () => {
    expect(currentDialogOptions("0.4.0")).toMatchObject({ message: "최신 버전을 쓰고 있어요", detail: "담화 0.4.0", buttons: ["확인"] });
    expect(failedDialogOptions("x")).toMatchObject({ message: "업데이트를 확인하지 못했어요", buttons: ["확인"] });
    expect(failedDialogOptions("x").detail).toContain("잠시 뒤 다시 시도해 주세요.");
  });
});

describe("failureMessage", () => {
  it("사유마다 문구가 있다", () => {
    expect(failureMessage({ kind: "failed", reason: "offline", detail: "" })).toContain("인터넷");
    expect(failureMessage({ kind: "failed", reason: "timeout", detail: "" })).toContain("10초");
    expect(failureMessage({ kind: "failed", reason: "http", detail: "HTTP 502" })).toContain("HTTP 502");
    expect(failureMessage({ kind: "failed", reason: "malformed", detail: "" })).toContain("읽지 못했어요");
    expect(failureMessage({ kind: "failed", reason: "no_release", detail: "" })).toContain("찾지 못했어요");
  });
  it("한도는 남은 분을 올림해 말한다", () => {
    expect(failureMessage({ kind: "failed", reason: "rate_limited", detail: "", retryAfterMs: 61_000 })).toContain("2분 뒤");
    expect(failureMessage({ kind: "failed", reason: "rate_limited", detail: "", retryAfterMs: 1 })).toContain("1분 뒤");
  });
});
