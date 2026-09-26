import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenSettingsSection } from "./hf-token-settings-section";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const base: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};
const ready = (state: HfTokenState) => ({ kind: "ready" as const, state });

test("hidden on the web", () => {
  const { container } = render(
    <HfTokenSettingsSection view={{ kind: "web" }} send={vi.fn()} />,
  );
  expect(container).toBeEmptyDOMElement();
});

test("present: masked value, account, and delete only after confirmation", () => {
  const send = vi.fn();
  render(
    <HfTokenSettingsSection
      view={ready({
        ...base,
        status: "present",
        masked: "hf_****…****4567",
        account: "jason",
      })}
      send={send}
    />,
  );
  expect(screen.getByText("hf_****…****4567")).toBeInTheDocument();
  expect(screen.getByText(/jason/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "토큰 지우기" }));
  expect(send).not.toHaveBeenCalledWith({ kind: "clear" });
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  expect(send).toHaveBeenCalledWith({ kind: "clear" });
});

test("absent and unreadable show the input; unavailable shows the keychain guidance", () => {
  const { unmount } = render(
    <HfTokenSettingsSection view={ready(base)} send={vi.fn()} />,
  );
  expect(
    screen.getByLabelText("허깅페이스 토큰", { selector: "input" }),
  ).toBeInTheDocument();
  unmount();
  const u = render(
    <HfTokenSettingsSection
      view={ready({ ...base, status: "unreadable" })}
      send={vi.fn()}
    />,
  );
  expect(screen.getByText(/토큰을 읽을 수 없어요/)).toBeInTheDocument();
  u.unmount();
  render(
    <HfTokenSettingsSection
      view={ready({ ...base, status: "unavailable" })}
      send={vi.fn()}
    />,
  );
  expect(
    screen.queryByLabelText("허깅페이스 토큰", { selector: "input" }),
  ).toBeNull();
  expect(screen.getByText(/키체인/)).toBeInTheDocument();
});

test("present: 입력 폼은 '토큰 바꾸기'를 눌러야 펼쳐지고, 지난 저장 문구는 보이지 않는다", () => {
  const present = {
    ...base,
    status: "present" as const,
    masked: "hf_****…****4567",
    account: "jason",
    message: { tone: "info" as const, text: "토큰을 저장했어요 — 계정 jason." },
  };
  const { rerender } = render(
    <HfTokenSettingsSection view={ready(present)} send={vi.fn()} />,
  );
  const input = () =>
    screen.queryByLabelText("허깅페이스 토큰", { selector: "input" });
  expect(input()).toBeNull();
  expect(screen.queryByText(/토큰을 저장했어요/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "토큰 바꾸기" }));
  expect(input()).toBeInTheDocument();
  expect(screen.getByText(/사용 조건에 동의하기/)).toBeInTheDocument();
  // 바꾸는 중의 오류는 펼친 채로 보인다 (마스킹 값이 그대로다)
  rerender(
    <HfTokenSettingsSection
      view={ready({
        ...present,
        message: { tone: "error", text: "허깅페이스 토큰이 유효하지 않아요." },
      })}
      send={vi.fn()}
    />,
  );
  expect(input()).toBeInTheDocument();
  expect(screen.getByRole("alert").textContent).toContain("유효하지 않아요");

  // 새 토큰으로 바뀌면(마스킹 값이 달라지면) 다시 접힌다
  rerender(
    <HfTokenSettingsSection
      view={ready({ ...present, masked: "hf_****…****9999" })}
      send={vi.fn()}
    />,
  );
  expect(input()).toBeNull();
  expect(screen.getByText("hf_****…****9999")).toBeInTheDocument();
});

test("present: 펼친 폼은 취소로 다시 접힌다, 안내 문구는 버튼 이름에 기대지 않는다", () => {
  render(
    <HfTokenSettingsSection
      view={ready({
        ...base,
        status: "present",
        masked: "hf_x",
        account: null,
      })}
      send={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "토큰 바꾸기" }));
  expect(screen.queryByText(/확인을 누르면/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(
    screen.queryByLabelText("허깅페이스 토큰", { selector: "input" }),
  ).toBeNull();
});
