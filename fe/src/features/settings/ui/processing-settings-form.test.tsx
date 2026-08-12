import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { Capabilities, ProcessingConfig } from "../api/types";
import { ProcessingSettingsForm } from "./processing-settings-form";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CONFIG: ProcessingConfig = {
  preset: "standard",
  preset_revision: "2026-08-12.2",
  language: "ko",
  whisper_model: "large-v3-turbo",
  devices: { diarization: "gpu", stt: "gpu" },
  summary_model: "qwen3.5:9b-mlx",
};

const CAPS: Capabilities = {
  platform: "darwin",
  arch: "arm64",
  chip: "Apple M2 Pro",
  memory_gb: 32,
  gpu_eligible: true,
  recommended_preset: "standard",
};

function mockApi(config = CONFIG, caps = CAPS) {
  vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
    if (url === "/settings/processing") return { data: config } as never;
    if (url === "/system/capabilities") return { data: caps } as never;
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProcessingSettingsForm />
    </QueryClientProvider>,
  );
}

test("현재 프리셋이 선택되고 추천 프리셋에 권장 배지가 붙는다", async () => {
  mockApi();
  renderForm();
  const standard = await screen.findByRole("radio", { name: /표준/ });
  expect(standard.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("권장")).toBeTruthy();
});

test("고급에서 모델을 바꾸면 custom으로 전환되고 저장 시 전 필드를 보낸다", async () => {
  mockApi();
  const put = vi
    .spyOn(apiClient, "put")
    .mockResolvedValue({ data: { ...CONFIG, preset: "custom" } } as never);
  renderForm();
  await screen.findByRole("radio", { name: /표준/ });

  fireEvent.click(screen.getByRole("button", { name: /고급 설정/ }));
  // 전사(STT) GPU 스위치를 끈다 → custom 전환
  fireEvent.click(screen.getByRole("switch", { name: /전사.*GPU/ }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/settings/processing", {
    preset: "custom",
    language: "ko",
    whisper_model: "large-v3-turbo",
    devices: { diarization: "gpu", stt: "cpu" },
    summary_model: "qwen3.5:9b-mlx",
  });
});

test("이름 프리셋 저장은 이름+언어만 보낸다", async () => {
  mockApi();
  const put = vi
    .spyOn(apiClient, "put")
    .mockResolvedValue({ data: CONFIG } as never);
  renderForm();
  fireEvent.click(await screen.findByRole("radio", { name: /가볍게/ }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/settings/processing", {
      preset: "light",
      language: "ko",
    }),
  );
});

test("gpu_eligible=false: 프리셋 카드 비활성 + 경고, gpu→cpu 끄기는 허용", async () => {
  // 현재 값이 gpu/gpu인 custom 설정 — 비지원 환경에서도 CPU로 끌 수 있어야 함
  mockApi(
    { ...CONFIG, preset: "custom", preset_revision: null },
    {
      ...CAPS,
      platform: "linux",
      arch: "x64",
      gpu_eligible: false,
      recommended_preset: null,
    },
  );
  renderForm();
  const standard = await screen.findByRole("radio", { name: /표준/ });
  // 모든 프리셋 카드 비활성 (전 프리셋이 diar gpu 포함 → 저장 시 400 예방)
  expect((standard as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/지원하지 않는 환경/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /고급 설정/ }));
  const sttSwitch = screen.getByRole("switch", {
    name: /전사.*GPU/,
  }) as HTMLInputElement;
  // 현재 gpu → 끄기 허용 (비대칭 규칙)
  expect(sttSwitch.disabled).toBe(false);
  fireEvent.click(sttSwitch);
  // cpu가 된 뒤에는 다시 켜기 차단
  expect(
    (screen.getByRole("switch", { name: /전사.*GPU/ }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
});

test("capabilities 로딩 전에는 프리셋 카드가 비활성이다 (보수적 기본값)", async () => {
  // capabilities만 pending으로 유지
  vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
    if (url === "/settings/processing") return { data: CONFIG } as never;
    return new Promise(() => {}) as never; // capabilities 영구 pending
  });
  renderForm();
  const standard = await screen.findByRole("radio", { name: /표준/ });
  expect((standard as HTMLButtonElement).disabled).toBe(true);
});

test("프리셋 카드에 요약 모델을 보여준다", async () => {
  mockApi();
  renderForm();
  expect(await screen.findByText(/qwen3.5:9b-mlx/)).toBeTruthy();
});

test("고급에서 요약 모델을 바꾸면 custom으로 전환된다", async () => {
  mockApi();
  renderForm();
  await screen.findByRole("radio", { name: /표준/ });
  fireEvent.click(screen.getByRole("button", { name: /고급 설정/ }));
  // Radix Select는 jsdom에서 pointer 이벤트를 못 받아 mousedown으로 열리지
  // 않는다. 트리거에 포커스 후 ArrowDown(키보드)으로 열고 옵션을 클릭한다.
  const trigger = screen.getByLabelText("요약 모델");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /27B/ }));
  expect(screen.getByText(/사용자 지정 설정을 쓰고 있어요/)).toBeTruthy();
});
