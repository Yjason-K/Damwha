import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { THEME_STORAGE_KEY, themeStore } from "@/shared/lib/theme";

import { ThemeMenu } from "./theme-menu";

let stop: () => void;
beforeEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  themeStore.setPreference("system");
  stop = themeStore.start();
});
afterEach(() => {
  cleanup();
  stop();
  themeStore.setPreference("system");
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.className = "";
});

test("버튼 이름이 현재 선택을 말하고, 메뉴에서 현재 선택에 체크가 있다", async () => {
  const user = userEvent.setup();
  render(<ThemeMenu />);
  await user.click(screen.getByRole("button", { name: "화면 테마: 시스템" }));
  expect(
    await screen.findByRole("menuitemradio", { name: "시스템 설정 따르기" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "다크" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("다크를 고르면 <html>이 다크가 되고 저장되며 버튼 이름이 바뀐다", async () => {
  const user = userEvent.setup();
  render(<ThemeMenu />);
  await user.click(screen.getByRole("button", { name: "화면 테마: 시스템" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "다크" }));
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(
    screen.getByRole("button", { name: "화면 테마: 다크" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("라이트로 돌아오면 다크 클래스가 빠진다", async () => {
  themeStore.setPreference("dark");
  const user = userEvent.setup();
  render(<ThemeMenu />);
  await user.click(screen.getByRole("button", { name: "화면 테마: 다크" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "라이트" }),
  );
  expect(document.documentElement).not.toHaveClass("dark");
  expect(document.documentElement.style.colorScheme).toBe("light");
});
