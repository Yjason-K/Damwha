import { expect, test } from "vitest";
import { createAppI18n } from "./create-i18n";

test("초기화가 동기다 — 만든 직후 t가 번역을 돌려준다", () => {
  const i = createAppI18n("en");
  expect(i.t("settings:general.title")).toBe("General");
});

test("언어를 바꾸면 같은 키가 그 언어로 나온다", async () => {
  const i = createAppI18n("ko");
  expect(i.t("settings:general.title")).toBe("일반");
  await i.changeLanguage("en");
  expect(i.t("settings:general.title")).toBe("General");
});

test("보간은 HTML 이스케이프를 하지 않는다 — React가 한다", () => {
  const i = createAppI18n("en");
  expect(i.t("common:test.echo", { value: "<b>" })).toBe("<b>");
});
