import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";

import { ResolveDialog } from "./resolve-dialog";
import type { ClusterInfo, Meeting } from "../model/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type WireSpeaker = { id: string; name: string; enrollment_status: string };

function cluster(over: Partial<ClusterInfo> = {}): ClusterInfo {
  return {
    id: "clu_1",
    diarLabel: "SPEAKER_00",
    spk: 1,
    resolvedSpeakerId: "spk_50",
    speakerName: "Speaker_050",
    speakerStatus: "provisional",
    suggestedSpeakerId: null,
    suggestedSpeakerName: null,
    suggestedSimilarity: null,
    ...over,
  };
}

function setup(speakers: WireSpeaker[], clusters: ClusterInfo[]) {
  const post = vi.fn().mockResolvedValue({
    data: {
      speaker_id: "spk_1",
      updated_utterances: 2,
      merged_speaker_deleted: false,
    },
  });
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: speakers } as never);
  vi.spyOn(apiClient, "post").mockImplementation(post as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ResolveDialog
        open
        onOpenChange={() => {}}
        meeting={{ id: "mtg_1", clusters } as Meeting}
      />
    </QueryClientProvider>,
  );
  return post;
}

/** Radix Select doesn't open on a jsdom click — focus the trigger, then ArrowDown. */
async function openPicker() {
  const trigger = await screen.findByRole("combobox");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  return screen.findByRole("listbox");
}

test("자동 생성된 provisional 화자도 고를 수 있다", async () => {
  // 신규 설치는 ready 화자가 0명이다. provisional을 빼면 목록이 통째로 비어
  // 같은 사람을 회의 간에 이어붙일 방법이 사라진다 — 원래 증상의 프론트 쪽 짝.
  setup(
    [{ id: "spk_23", name: "Speaker_023", enrollment_status: "provisional" }],
    [cluster()],
  );
  const listbox = await openPicker();
  expect(within(listbox).getByText("Speaker_023")).toBeInTheDocument();
});

test("성문 등록이 끝나지 않은 화자(pending/failed)는 목록에서 뺀다", async () => {
  setup(
    [
      { id: "spk_1", name: "김영재", enrollment_status: "ready" },
      { id: "spk_2", name: "등록중", enrollment_status: "pending" },
      { id: "spk_3", name: "실패", enrollment_status: "failed" },
    ],
    [cluster()],
  );
  const listbox = await openPicker();
  expect(within(listbox).getByText("김영재")).toBeInTheDocument();
  expect(within(listbox).queryByText("등록중")).not.toBeInTheDocument();
  expect(within(listbox).queryByText("실패")).not.toBeInTheDocument();
});

test("자기 자신에게 연결하는 선택지는 제공하지 않는다", async () => {
  setup(
    [
      { id: "spk_50", name: "Speaker_050", enrollment_status: "provisional" },
      { id: "spk_23", name: "Speaker_023", enrollment_status: "provisional" },
    ],
    [cluster({ resolvedSpeakerId: "spk_50" })],
  );
  const listbox = await openPicker();
  expect(within(listbox).queryByText("Speaker_050")).not.toBeInTheDocument();
  expect(within(listbox).getByText("Speaker_023")).toBeInTheDocument();
});

test("제안이 있으면 후보를 미리 골라두고 이유와 유사도를 보여준다", async () => {
  setup(
    [{ id: "spk_23", name: "이수민", enrollment_status: "provisional" }],
    [
      cluster({
        suggestedSpeakerId: "spk_23",
        suggestedSpeakerName: "이수민",
        suggestedSimilarity: 0.714,
      }),
    ],
  );
  expect(await screen.findByText("추천")).toBeInTheDocument();
  expect(screen.getByText(/유사도 71%/)).toBeInTheDocument();
  // 미리 고른 것이지 자동 적용이 아니다 — 트리거에 이름이 떠 있고, 연결은 아직이다.
  expect(await screen.findByRole("combobox")).toHaveTextContent("이수민");
});

test("제안을 확인하면 그 화자로 resolve를 호출한다", async () => {
  const post = setup(
    [{ id: "spk_23", name: "이수민", enrollment_status: "provisional" }],
    [
      cluster({
        suggestedSpeakerId: "spk_23",
        suggestedSpeakerName: "이수민",
        suggestedSimilarity: 0.71,
      }),
    ],
  );
  fireEvent.click(await screen.findByRole("button", { name: "연결" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/meetings/mtg_1/clusters/clu_1/resolve",
      {
        speaker_id: "spk_23",
      },
    ),
  );
});

test("제안이 없으면 아무것도 미리 고르지 않아 연결 버튼이 잠겨 있다", async () => {
  setup(
    [{ id: "spk_1", name: "김영재", enrollment_status: "ready" }],
    [cluster()],
  );
  expect(screen.queryByText("추천")).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "연결" })).toBeDisabled();
});
