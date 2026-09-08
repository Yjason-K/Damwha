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
import * as sim from "@/features/demo/model/upload-simulation";
import { setTourActive } from "@/features/demo/model/tour-active";
import { NewMeetingDialog } from "./new-meeting-dialog";

afterEach(() => {
  cleanup();
  setTourActive(false);
});

vi.mock("@/shared/config/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/shared/config/env")>();
  return {
    env: {
      ...mod.env,
      demoMode: true,
      demoTour: {
        meetingId: "mtg_7",
        fileLabel: "테스트.m4a · 42.0 MB",
        searchQuery: "프롬프트",
      },
    },
  };
});

test("데모: 파일 선택 대신 테스트 오디오가 놓이고, 제출은 시뮬레이션만 시작한다", async () => {
  localStorage.setItem("damwha:new-meeting-source", "live");
  const post = vi.spyOn(apiClient, "post");
  const start = vi
    .spyOn(sim, "startUploadSimulation")
    .mockImplementation(() => {});
  const onCreated = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog open onOpenChange={() => {}} onCreated={onCreated} />
    </QueryClientProvider>,
  );

  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(screen.getByText("테스트.m4a · 42.0 MB")).toBeInTheDocument();
  expect(screen.getByText(/데모라 파일을 받지 않아요/)).toBeInTheDocument();

  const submit = screen.getByRole("button", { name: "업로드 시작" });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);

  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("mtg_7"));
  expect(start).toHaveBeenCalledWith("mtg_7", qc);
  expect(post).not.toHaveBeenCalled();
});

/**
 * driver의 오버레이는 이 모달 위를 덮는다 — 스포트라이트 밖을 누르면 Radix가 "바깥 클릭"으로
 * 읽는다. 투어 중에 그걸로 모달이 닫히면 다음 단계가 안의 버튼을 못 찾아 건너뛴다.
 */
test("투어 중에는 바깥 클릭·ESC로 모달이 닫히지 않는다", () => {
  setTourActive(true);
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NewMeetingDialog open onOpenChange={onOpenChange} onCreated={vi.fn()} />
    </QueryClientProvider>,
  );

  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "Escape" });

  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByText("새 회의 기록하기")).toBeInTheDocument();
});

test("투어 밖에서는 ESC로 모달이 닫힌다", () => {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NewMeetingDialog open onOpenChange={onOpenChange} onCreated={vi.fn()} />
    </QueryClientProvider>,
  );

  fireEvent.keyDown(document.body, { key: "Escape" });

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

/**
 * 실시간 녹음은 데모에서 돌릴 수 없지만(읽기 전용 + 워커 없음) 기능이 있다는 건 보여준다.
 * 대신 게이트를 돌리지 않아 마이크 권한 프롬프트가 뜨지 않고, 시작 버튼은 잠겨 있다.
 */
test("데모: 실시간 녹음 탭은 보이되 시작할 수 없다", () => {
  const post = vi.spyOn(apiClient, "post");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NewMeetingDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    </QueryClientProvider>,
  );

  // Radix Tabs는 click이 아니라 mousedown/focus로 전환한다(live 테스트와 같은 방식).
  fireEvent.mouseDown(screen.getByRole("tab", { name: "실시간 녹음" }), {
    button: 0,
    ctrlKey: false,
  });

  expect(
    screen.getByText(/데모에서는 녹음을 시작할 수 없어요/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "녹음 시작" })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
});
