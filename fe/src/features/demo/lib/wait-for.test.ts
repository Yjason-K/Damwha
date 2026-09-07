import { afterEach, expect, test, vi } from "vitest";

import { clickTour, waitFor, waitUntil } from "./wait-for";

afterEach(() => {
  document.body.innerHTML = "";
});

test("이미 있는 요소는 즉시 돌려준다", async () => {
  document.body.innerHTML = '<div data-tour="a"></div>';
  expect(await waitFor('[data-tour="a"]')).toBe(
    document.querySelector('[data-tour="a"]'),
  );
});

test("나중에 나타나는 요소를 기다린다", async () => {
  const p = waitFor('[data-tour="b"]', 1000);
  setTimeout(() => {
    document.body.innerHTML = '<div data-tour="b"></div>';
  }, 20);
  expect(await p).not.toBeNull();
});

test("타임아웃이면 null", async () => {
  expect(await waitFor('[data-tour="none"]', 30)).toBeNull();
});

test("clickTour는 요소가 button이면 그것을, 아니면 안의 첫 button을 누른다", () => {
  const onA = vi.fn();
  const onB = vi.fn();
  document.body.innerHTML =
    '<button data-tour="a"></button><div data-tour="b"><button id="inner"></button></div>';
  document.querySelector('[data-tour="a"]')!.addEventListener("click", onA);
  document.querySelector("#inner")!.addEventListener("click", onB);
  expect(clickTour("a")).toBe(true);
  expect(clickTour("b")).toBe(true);
  expect(clickTour("zzz")).toBe(false);
  expect(onA).toHaveBeenCalledTimes(1);
  expect(onB).toHaveBeenCalledTimes(1);
});

test("waitUntil은 이미 참이면 곧바로 true", async () => {
  expect(await waitUntil(() => true)).toBe(true);
});

test("waitUntil은 나중에 참이 되면 true", async () => {
  let ready = false;
  setTimeout(() => {
    ready = true;
  }, 60);
  expect(await waitUntil(() => ready, 1000)).toBe(true);
});

test("waitUntil은 타임아웃이면 false", async () => {
  expect(await waitUntil(() => false, 80)).toBe(false);
});
