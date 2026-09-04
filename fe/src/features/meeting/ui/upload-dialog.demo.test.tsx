import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import * as sim from "@/features/demo/model/upload-simulation";
import { UploadDialog } from "./upload-dialog";

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
  const post = vi.spyOn(apiClient, "post");
  const start = vi
    .spyOn(sim, "startUploadSimulation")
    .mockImplementation(() => {});
  const onUploaded = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UploadDialog open onOpenChange={() => {}} onUploaded={onUploaded} />
    </QueryClientProvider>,
  );

  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(screen.getByText("테스트.m4a · 42.0 MB")).toBeInTheDocument();
  expect(screen.getByText(/데모라 파일을 받지 않아요/)).toBeInTheDocument();

  const submit = screen.getByRole("button", { name: "업로드" });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);

  await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("mtg_7"));
  expect(start).toHaveBeenCalledWith("mtg_7", qc);
  expect(post).not.toHaveBeenCalled();
});
