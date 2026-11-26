import { describe, expect, it } from "vitest";
import {
  RENDERER_GONE_BUTTONS,
  decideRendererGone,
  rendererGoneChoice,
  rendererGoneDialogOptions,
} from "../../src/windows/renderer-recovery";

/**
 * 렌더러가 죽은 창 (#145). 고치기 전에는 검은 화면으로 남았고 View > Reload도 그것을 되살리지 못했다(실측 — 메뉴는
 * 죽은 창에서 아무것도 하지 않고, `webContents.reload()`는 새 렌더러를 띄워 화면과 브리지를 되살린다).
 */
describe("decideRendererGone", () => {
  const base = { reason: "crashed", quitting: false, destroyed: false, prompting: false };

  it("offers a reload when the renderer died under a live window", () => {
    for (const reason of ["crashed", "killed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"]) {
      expect(decideRendererGone({ ...base, reason })).toBe("prompt");
    }
  });

  it("stays quiet on a clean exit — nothing died", () => {
    expect(decideRendererGone({ ...base, reason: "clean-exit" })).toBe("ignore");
  });

  it("stays quiet while quitting — the quit flow is tearing the window down", () => {
    // 되돌릴 수 없는 지점 뒤에 대화상자를 띄우면 종료 중인 앱 앞에 "다시 불러올까요"가 뜬다.
    expect(decideRendererGone({ ...base, quitting: true })).toBe("ignore");
  });

  it("stays quiet when the window itself is gone", () => {
    expect(decideRendererGone({ ...base, destroyed: true })).toBe("ignore");
  });

  it("does not stack a second dialog over one already asking", () => {
    expect(decideRendererGone({ ...base, prompting: true })).toBe("ignore");
  });
});

describe("rendererGoneDialogOptions", () => {
  it("defaults to reload and lets Escape mean 'later'", () => {
    // cancelId가 없으면 Electron이 한국어 라벨에서 취소 버튼을 못 찾아 Escape가 0번을 고를 수 있다 (dialogs.ts와 같은 이유).
    const o = rendererGoneDialogOptions();
    expect(o.buttons).toEqual([...RENDERER_GONE_BUTTONS]);
    expect(o.defaultId).toBe(0);
    expect(o.cancelId).toBe(1);
    expect(o.noLink).toBe(true);
  });

  it("tells the user a recording in that window is finished by the server", () => {
    expect(rendererGoneDialogOptions().detail).toContain("서버가");
  });
});

describe("rendererGoneChoice", () => {
  it("reloads only on the first button", () => {
    expect(rendererGoneChoice(0)).toBe("reload");
    expect(rendererGoneChoice(1)).toBe("later");
  });
});
