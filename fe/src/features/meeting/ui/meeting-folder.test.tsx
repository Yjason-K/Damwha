import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { MeetingFolder } from "./meeting-folder";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FOLDERS = [
  { id: "fld_1", name: "기본 폴더", is_default: true, created_at: "" },
  { id: "fld_2", name: "기획팀", is_default: false, created_at: "" },
];

function renderFolder(folderId: string | null) {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: FOLDERS } as never);
  const patch = vi
    .spyOn(apiClient, "patch")
    .mockResolvedValue({ data: {} } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MeetingFolder meetingId="mtg_1" folderId={folderId} />
    </QueryClientProvider>,
  );
  return patch;
}

test("회의의 폴더를 보여 주고, 다른 폴더를 고르면 PATCH로 옮긴다", async () => {
  const patch = renderFolder("fld_1");
  fireEvent.click(
    await screen.findByRole("button", { name: "폴더: 기본 폴더 (옮기기)" }),
  );
  const list = await screen.findByRole("list", { name: "옮길 폴더" });
  expect(
    within(list).getByRole("button", { name: "기본 폴더" }),
  ).toHaveAttribute("aria-current", "true");

  fireEvent.click(within(list).getByRole("button", { name: "기획팀" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("/meetings/mtg_1", {
      folder_id: "fld_2",
    }),
  );
});

test("지금 폴더를 다시 고르면 요청하지 않는다", async () => {
  const patch = renderFolder("fld_2");
  fireEvent.click(
    await screen.findByRole("button", { name: "폴더: 기획팀 (옮기기)" }),
  );
  const list = await screen.findByRole("list", { name: "옮길 폴더" });
  fireEvent.click(within(list).getByRole("button", { name: "기획팀" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("list", { name: "옮길 폴더" }),
    ).not.toBeInTheDocument(),
  );
  expect(patch).not.toHaveBeenCalled();
});

test("폴더를 모르면(목록에 없거나 응답에 없으면) 아무것도 그리지 않는다", async () => {
  renderFolder(null);
  await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: /^폴더:/ })).toBeNull();
});
