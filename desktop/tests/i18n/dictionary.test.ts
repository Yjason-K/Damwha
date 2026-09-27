import { describe, expect, it } from "vitest";
import { t } from "../../src/i18n/dictionary";

describe("desktop 사전", () => {
  it("언어별 문구", () => {
    expect(t("ko", "menu.serviceStatus")).toBe("서비스 상태");
    expect(t("en", "menu.serviceStatus")).toBe("Service status");
  });
  it("{{이름}} 보간 — 없는 변수는 그대로 둔다", () => {
    expect(t("en", "test.echo", { value: 3 })).toBe("3");
    expect(t("en", "test.echo")).toBe("{{value}}");
  });
});
