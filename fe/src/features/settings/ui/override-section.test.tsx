import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { ProcessingOverride } from "../api/types";
import { OverrideSection } from "./override-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSection(
  value: ProcessingOverride | undefined,
  onChange: (v: ProcessingOverride | undefined) => void,
) {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard",
      preset_revision: "2026-08-12.1",
      language: "ko",
      whisper_model: "large-v3-turbo",
      devices: { diarization: "gpu", stt: "gpu" },
      summary_model: "qwen3.5:8b-mlx",
    },
  } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OverrideSection value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
}

test("기본 접힘 — 토글하면 프리셋 선택이 보인다", () => {
  renderSection(undefined, () => {});
  expect(screen.queryByLabelText("이번 작업 프리셋")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  expect(screen.getByLabelText("이번 작업 프리셋")).toBeTruthy();
});

test("프리셋을 고르면 onChange에 override가 전달된다", async () => {
  const onChange = vi.fn();
  renderSection(undefined, onChange);
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  // Radix Select는 jsdom에서 pointer 이벤트를 못 받아 mousedown으로 열리지
  // 않는다. 트리거에 포커스 후 ArrowDown(키보드)으로 열고 옵션을 클릭한다.
  const trigger = screen.getByLabelText("이번 작업 프리셋");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /고품질/ }));
  expect(onChange).toHaveBeenCalledWith({ preset: "quality" });
});

test("섹션을 닫으면 override가 해제된다", () => {
  const onChange = vi.fn();
  renderSection({ preset: "quality" }, onChange);
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  expect(onChange).toHaveBeenCalledWith(undefined);
});

test("요약 모델만 고르면 그 값만 담긴 override를 올려보낸다", async () => {
  const onChange = vi.fn();
  renderSection(undefined, onChange);
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  const trigger = screen.getByLabelText("이번 작업 요약 모델");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /14B/ }));
  expect(onChange).toHaveBeenCalledWith({ summary_model: "qwen3.5:14b-mlx" });
});

test("프리셋 선택 뒤 요약 모델을 바꾸면 두 값이 함께 유지된다", async () => {
  const onChange = vi.fn();
  renderSection({ preset: "light" }, onChange);
  const trigger = screen.getByLabelText("이번 작업 요약 모델");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /14B/ }));
  expect(onChange).toHaveBeenCalledWith({
    preset: "light",
    summary_model: "qwen3.5:14b-mlx",
  });
});

test("부모가 value를 리셋하면 섹션이 닫힌다", () => {
  const { rerender } = renderSection({ preset: "quality" }, () => {});
  expect(screen.getByLabelText("이번 작업 프리셋")).toBeTruthy();
  rerender(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OverrideSection value={undefined} onChange={() => {}} />
    </QueryClientProvider>,
  );
  expect(screen.queryByLabelText("이번 작업 프리셋")).toBeNull();
});
