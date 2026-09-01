import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Meeting } from "../model/types";
import { ExportDialog, type ExportMeeting } from "./export-dialog";

const MEETING: ExportMeeting = {
  title: "주간 회의",
  date: "2026-08-27",
  speakers: {
    1: { id: "spk_1", name: "김영재", role: "", spk: 1 },
    2: { id: "spk_2", name: "홍길동", role: "", spk: 2 },
  } as Meeting["speakers"],
  utterances: [
    {
      id: "u1",
      spk: 1,
      t: "00:12",
      text: "안녕하세요",
      status: "ok",
      sources: [
        { id: "u1", startMs: 12_000, endMs: 14_000, text: "안녕하세요" },
      ],
    },
    {
      id: "u2",
      spk: 2,
      t: "00:20",
      text: "시작하죠",
      status: "ok",
      sources: [{ id: "u2", startMs: 20_000, endMs: 22_000, text: "시작하죠" }],
    },
  ],
};

let blobs: Blob[];
let anchors: HTMLAnchorElement[];
let revoked: string[];

beforeEach(() => {
  blobs = [];
  anchors = [];
  revoked = [];
  // jsdom에는 objectURL이 없다 — 환경 보충이지 동작 대역이 아니다.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (b: Blob) => {
      blobs.push(b);
      return `blob:${blobs.length}`;
    },
    revokeObjectURL: (u: string) => revoked.push(u),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchors.push(this);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(onOpenChange = vi.fn()) {
  render(<ExportDialog open onOpenChange={onOpenChange} meeting={MEETING} />);
  return onOpenChange;
}

const body = () => blobs[blobs.length - 1].text();

test("기본값은 txt + 시간·화자 모두 포함이다", async () => {
  setup();
  expect(screen.getByRole("radio", { name: "TXT" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "시간 기록 포함" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "화자 이름 포함" })).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));

  expect(await body()).toBe(
    "[00:12] 김영재: 안녕하세요\n\n[00:20] 홍길동: 시작하죠\n",
  );
  expect(anchors[0].download).toBe("주간 회의_2026-08-27.txt");
});

test("시간 토글을 끄면 시각 표기 없이 내보낸다", async () => {
  setup();
  fireEvent.click(screen.getByRole("switch", { name: "시간 기록 포함" }));
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));

  expect(await body()).toBe("김영재: 안녕하세요\n\n홍길동: 시작하죠\n");
});

test("srt를 고르면 시간 토글이 사라지고 자막 규격으로 내보낸다", async () => {
  setup();
  fireEvent.click(screen.getByRole("radio", { name: "SRT" }));

  expect(screen.queryByRole("switch", { name: "시간 기록 포함" })).toBeNull();
  expect(screen.getByRole("switch", { name: "화자 이름 포함" })).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));

  expect(await body()).toBe(
    "1\n00:00:12,000 --> 00:00:14,000\n김영재: 안녕하세요\n\n" +
      "2\n00:00:20,000 --> 00:00:22,000\n홍길동: 시작하죠\n",
  );
  expect(anchors[0].download).toBe("주간 회의_2026-08-27.srt");
});

test("화자 토글은 형식을 바꿔도 유지된다", async () => {
  setup();
  fireEvent.click(screen.getByRole("switch", { name: "화자 이름 포함" }));
  fireEvent.click(screen.getByRole("radio", { name: "SRT" }));
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));

  expect(await body()).toBe(
    "1\n00:00:12,000 --> 00:00:14,000\n안녕하세요\n\n" +
      "2\n00:00:20,000 --> 00:00:22,000\n시작하죠\n",
  );
});

test("내보낸 뒤 objectURL을 반납하고 다이얼로그를 닫는다", () => {
  const onOpenChange = setup();
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));

  expect(revoked).toEqual(["blob:1"]);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("발화가 없으면 내보내기 버튼이 비활성이다", () => {
  render(
    <ExportDialog
      open
      onOpenChange={vi.fn()}
      meeting={{ ...MEETING, utterances: [] }}
    />,
  );
  expect(screen.getByRole("button", { name: "내보내기" })).toBeDisabled();
});
