import { afterEach, expect, test } from "vitest";
import { i18n, languageStore } from "./index";

afterEach(() => {
  languageStore.bridge.show("ko");
});

test("테스트 환경은 한국어로 시작한다 (vitest.setup.ts가 저장값을 ko로 둔다)", () => {
  expect(languageStore.getSnapshot()).toBe("ko");
  expect(i18n.language).toBe("ko");
});

test("저장소가 바뀌면 i18n이 따라간다", () => {
  languageStore.bridge.show("en");
  expect(i18n.language).toBe("en");
  expect(i18n.t("settings:general.title")).toBe("General");
});
