import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenGateProvider } from "./hf-token-gate";
import { HfFailureAction } from "./hf-failure-action";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const state: HfTokenState = {
  status: "present",
  masked: "hf_****…****4567",
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

test("accept: opens the conditions page by key", () => {
  const send = vi.fn();
  render(
    <HfTokenGateProvider view={{ kind: "ready", state }} send={send}>
      <HfFailureAction action="accept" send={send} />
    </HfTokenGateProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "사용 조건 페이지 열기" }),
  );
  expect(send).toHaveBeenCalledWith({ kind: "open", link: "accept" });
});

test("token: opens the token dialog even when a (revoked) token is present", () => {
  render(
    <HfTokenGateProvider view={{ kind: "ready", state }} send={vi.fn()}>
      <HfFailureAction action="token" />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "토큰 설정 열기" }));
  expect(
    screen.getByRole("dialog", { name: "허깅페이스 토큰이 필요해요" }),
  ).toBeInTheDocument();
});

test("no button on the web", () => {
  const { container } = render(
    <HfTokenGateProvider view={{ kind: "web" }} send={vi.fn()}>
      <HfFailureAction action="token" />
    </HfTokenGateProvider>,
  );
  expect(container.querySelector("button")).toBeNull();
});
