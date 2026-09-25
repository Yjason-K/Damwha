import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenForm } from "./hf-token-form";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";
const base: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

test("submits the typed token and the two HF links as keys", () => {
  const send = vi.fn();
  render(<HfTokenForm state={base} send={send} />);
  fireEvent.change(screen.getByLabelText("허깅페이스 토큰"), {
    target: { value: TOKEN },
  });
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  expect(send).toHaveBeenCalledWith({ kind: "submit", token: TOKEN });
  fireEvent.click(
    screen.getByRole("button", { name: "사용 조건 페이지 열기" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "토큰 만들기 페이지 열기" }),
  );
  expect(send).toHaveBeenCalledWith({ kind: "open", link: "accept" });
  expect(send).toHaveBeenCalledWith({ kind: "open", link: "tokens" });
});

test("keeps the typed value after an error so one character can be fixed (Review Focus 3)", () => {
  const send = vi.fn();
  const { rerender } = render(<HfTokenForm state={base} send={send} />);
  const input = screen.getByLabelText("허깅페이스 토큰") as HTMLInputElement;
  fireEvent.change(input, { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  rerender(
    <HfTokenForm
      state={{
        ...base,
        message: { tone: "error", text: "허깅페이스 토큰이 유효하지 않아요." },
      }}
      send={send}
    />,
  );
  expect(input.value).toBe(TOKEN);
  expect(screen.getByRole("alert")).toHaveTextContent("유효하지 않아요");
});

test("locks while busy and does not submit an empty value", () => {
  const send = vi.fn();
  const { rerender } = render(<HfTokenForm state={base} send={send} />);
  expect(screen.getByRole("button", { name: "확인" })).toBeDisabled();
  rerender(<HfTokenForm state={{ ...base, busy: true }} send={send} />);
  expect(screen.getByLabelText("허깅페이스 토큰")).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

test("renders HF's message as text, never as markup", () => {
  render(
    <HfTokenForm
      state={{
        ...base,
        message: { tone: "error", text: "<img src=x onerror=alert(1)>" },
      }}
      send={vi.fn()}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "<img src=x onerror=alert(1)>",
  );
  expect(document.querySelector("img")).toBeNull();
});

test("Finding 3: a second submit before any state update from main does not send twice", () => {
  const send = vi.fn();
  render(<HfTokenForm state={base} send={send} />);
  fireEvent.change(screen.getByLabelText("허깅페이스 토큰"), {
    target: { value: TOKEN },
  });
  const button = screen.getByRole("button", { name: "확인" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(send).toHaveBeenCalledTimes(1);
});

test("Finding 3: clears the typed value once masked changes to a new value (successful replace)", () => {
  const send = vi.fn();
  const { rerender } = render(
    <HfTokenForm
      state={{ ...base, status: "present", masked: "hf_****…****0000" }}
      send={send}
    />,
  );
  const input = screen.getByLabelText("허깅페이스 토큰") as HTMLInputElement;
  fireEvent.change(input, { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  rerender(
    <HfTokenForm
      state={{
        ...base,
        status: "present",
        masked: "hf_****…****4567",
        account: "jason",
        message: { tone: "info", text: "토큰을 저장했어요 — 계정 jason." },
      }}
      send={send}
    />,
  );
  expect(input.value).toBe("");
});

test("shows the keychain guidance instead of an input when unavailable", () => {
  render(
    <HfTokenForm state={{ ...base, status: "unavailable" }} send={vi.fn()} />,
  );
  expect(screen.queryByLabelText("허깅페이스 토큰")).toBeNull();
  expect(screen.getByText(/키체인/)).toBeInTheDocument();
});
