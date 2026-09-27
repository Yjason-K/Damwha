import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { languageStore } from "@/shared/i18n";
import { GeneralSettingsSection } from "./general-settings-section";

afterEach(() => {
  cleanup();
  languageStore.bridge.show("ko");
});

async function pick(name: RegExp) {
  const trigger = screen.getByLabelText(/화면 언어|Display language/);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

test("선택지는 각 언어의 자기 이름이다 — 읽지 못하는 화면에서도 자기 언어는 찾는다", async () => {
  render(<GeneralSettingsSection />);
  const trigger = screen.getByLabelText("화면 언어");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(await screen.findByRole("option", { name: "한국어" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
});

test("English를 고르면 화면이 바로 영어가 되고, <html lang>이 바뀌고, main에 전달된다", async () => {
  render(<GeneralSettingsSection />);
  const asked = languageStore.bridge.next();
  await pick(/English/);
  expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
  expect(document.documentElement.lang).toBe("en");
  await expect(asked).resolves.toBe("en");
});
