import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import type { Meeting } from "@/features/meeting/model/types";
import { ShareDialog } from "./share-dialog";
import type { ShareView } from "../api/share";

const PAYLOAD = {
  v: 1,
  created_at: "2026-10-09T00:00:00.000Z",
  ui_language: "ko",
  meeting: {
    title: "주간 회의",
    recorded_at: "2026-10-08T01:00:00.000Z",
    duration_ms: 60000,
  },
  speakers: [],
  summary: { topics: ["배포 일정"], segments: [] },
};
const meeting = (over: Partial<Meeting> = {}) =>
  ({
    id: "mtg_1",
    title: "주간 회의",
    status: "done",
    summaryStatus: "done",
    ...over,
  }) as Meeting;
const ACTIVE: ShareView = {
  id: "shr_1",
  meeting_id: "mtg_1",
  status: "active",
  url: "https://share.example/s/7-x#KEY",
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  scope: {
    summary: true,
    lenses: true,
    transcript: false,
    note: false,
    anonymize: false,
  },
  duration_days: 7,
  created_at: "2026-10-09T00:00:00.000Z",
};

type Scope = {
  summary: boolean;
  lenses: boolean;
  transcript: boolean;
  note: boolean;
  anonymize: boolean;
};
/** 범위마다 다른 미리보기 — 화면에 뜬 미리보기가 "지금 고른 범위의 것"인지 글자로 구분한다. */
const topicFor = (scope: Scope) =>
  scope.note ? "메모 포함본" : scope.transcript ? "발화 포함본" : "배포 일정";
const previewResponse = (scope: Scope) =>
  ({
    data: {
      payload: {
        ...PAYLOAD,
        summary: { topics: [topicFor(scope)], segments: [] },
      },
      expires_at_estimate: "2026-10-16T00:00:00.000Z",
    },
  }) as never;

let post: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  post = vi
    .spyOn(apiClient, "post")
    .mockImplementation(async (url: string, body?: unknown) => {
      if (url.endsWith("/preview"))
        return previewResponse((body as { scope: Scope }).scope);
      return { data: { share: ACTIVE } } as never;
    });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDialog(
  props: Partial<React.ComponentProps<typeof ShareDialog>> = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShareDialog
        meeting={meeting()}
        current={null}
        open
        onOpenChange={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

const submit = () => screen.getByRole("button", { name: "링크 만들기" });
const consent = () =>
  fireEvent.click(
    screen.getByLabelText(
      "위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요",
    ),
  );
/** 그 범위의 미리보기가 그려질 때까지 — 그 전에는 공유 버튼이 꺼져 있다. */
const previewShown = async (topic = "배포 일정") => {
  const region = await screen.findByRole("region", {
    name: "받는 사람에게 이렇게 보여요",
  });
  await within(region).findByText(topic);
};

test("기본 동의를 체크하기 전에는 링크를 만들 수 없다", async () => {
  renderDialog();
  await previewShown();
  expect(submit()).toBeDisabled();
  consent();
  expect(submit()).toBeEnabled();
});

test("미리보기가 오기 전과 실패했을 때는 동의해도 버튼이 꺼져 있다", async () => {
  let release: (() => void) | undefined;
  post.mockImplementation(
    (url: string) =>
      new Promise((resolve, reject) => {
        if (!url.endsWith("/preview"))
          return resolve({ data: { share: ACTIVE } } as never);
        release = () => reject(new ApiError(500, "x"));
      }),
  );
  renderDialog();
  consent();
  await waitFor(() => expect(release).toBeDefined()); // 미리보기 요청이 나갔다
  expect(submit()).toBeDisabled(); // 아직 미리보기가 없다
  release!();
  expect(
    await screen.findByText("미리보기를 만들지 못했어요."),
  ).toBeInTheDocument(); // F16
  expect(submit()).toBeDisabled(); // 실패한 미리보기로는 공유하지 않는다
});

test("발화 기록을 켜면 책임 확인이 나타나고, 체크해야 버튼이 켜진다", async () => {
  renderDialog();
  consent();
  expect(
    screen.queryByLabelText(
      "참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요",
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "발화 기록" }));
  expect(
    screen.getByText(/발화 기록에는 다른 참석자의 발언이 그대로/),
  ).toBeInTheDocument();
  await previewShown("발화 포함본"); // 새 범위의 미리보기
  expect(submit()).toBeDisabled(); // 책임 확인 전

  fireEvent.click(
    screen.getByLabelText(
      "참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요",
    ),
  );
  expect(submit()).toBeEnabled();
});

test("범위를 바꾸면 새 범위의 미리보기가 올 때까지 버튼이 꺼진다", async () => {
  renderDialog();
  consent();
  await previewShown("배포 일정");
  expect(submit()).toBeEnabled();
  let answer: (() => void) | undefined;
  post.mockImplementation((url: string, body?: unknown) =>
    url.endsWith("/preview")
      ? new Promise((resolve) => {
          answer = () =>
            resolve(previewResponse((body as { scope: Scope }).scope));
        })
      : Promise.resolve({ data: { share: ACTIVE } } as never),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "메모" }));
  await waitFor(() => expect(answer).toBeDefined());
  expect(post).toHaveBeenLastCalledWith(
    "/meetings/mtg_1/share/preview",
    expect.objectContaining({ scope: expect.objectContaining({ note: true }) }),
  );
  expect(submit()).toBeDisabled(); // 옛 범위의 미리보기로는 공유하지 않는다
  answer!();
  await previewShown("메모 포함본");
  expect(submit()).toBeEnabled();
});

test("요약이 done이 아니면 요약 체크는 꺼져 있고 비활성이다", () => {
  renderDialog({ meeting: meeting({ summaryStatus: "failed" }) });
  const box = screen.getByRole("checkbox", {
    name: "요약",
  }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(box.disabled).toBe(true);
  expect(screen.getByText("요약이 아직 없어요")).toBeInTheDocument();
});

test("내용을 하나도 고르지 않으면 버튼이 꺼진다", () => {
  renderDialog();
  fireEvent.click(
    screen.getByLabelText(
      "위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요",
    ),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "요약" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "할 일·결정·약속" }));
  expect(submit()).toBeDisabled();
});

test("미리보기는 be가 만든 페이로드를 공유 렌더러로 그린다", async () => {
  renderDialog();
  const preview = await screen.findByRole("region", {
    name: "받는 사람에게 이렇게 보여요",
  });
  expect(await within(preview).findByText("배포 일정")).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith(
    "/meetings/mtg_1/share/preview",
    expect.objectContaining({ ui_language: "ko", duration_days: 7 }),
  );
});

test("익명화 토글 아래에 자유 텍스트 한계를 적는다", () => {
  renderDialog();
  expect(
    screen.getByText(
      "요약·할 일 문장 안에 적힌 이름은 그대로 남아요. 미리보기에서 확인해 주세요.",
    ),
  ).toBeInTheDocument();
});

test("이미 공유 중이면 새 링크 화면에 기존 링크 중지 경고가 뜬다", () => {
  renderDialog({ current: ACTIVE });
  fireEvent.click(screen.getByRole("button", { name: "새 링크 만들기" }));
  expect(
    screen.getByText(/기존 링크\(5일 남음\)는 바로 중지되고/),
  ).toBeInTheDocument();
});

test("409는 '이미 만드는 중' 문구로 알린다", async () => {
  post.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview"))
      return previewResponse({
        summary: true,
        lenses: true,
        transcript: false,
        note: false,
        anonymize: false,
      });
    throw new ApiError(409, "x", "SHARE_IN_PROGRESS");
  });
  renderDialog();
  consent();
  await previewShown();
  fireEvent.click(submit());
  expect(
    await screen.findByText("이미 이 회의의 공유 링크를 만드는 중이에요."),
  ).toBeInTheDocument();
});

test("만들기에 성공하면 관리 화면 — 링크 복사", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: write } });
  renderDialog();
  consent();
  await previewShown();
  fireEvent.click(submit());
  fireEvent.click(await screen.findByRole("button", { name: "링크 복사" }));
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith("https://share.example/s/7-x#KEY"),
  );
});

test("철회 대기 중이면 복사 버튼이 없고 안내만 있다", () => {
  renderDialog({ current: { ...ACTIVE, status: "revoke_pending", url: null } });
  expect(screen.queryByRole("button", { name: "링크 복사" })).toBeNull();
  expect(
    screen.getByText("중지 대기 중이에요. 인터넷에 연결되면 중지돼요."),
  ).toBeInTheDocument();
});

test("중지 — 202면 대기 안내", async () => {
  vi.spyOn(apiClient, "delete").mockResolvedValue({
    status: 202,
    data: { share: { ...ACTIVE, status: "revoke_pending", url: null } },
  } as never);
  renderDialog({ current: ACTIVE });
  fireEvent.click(screen.getByRole("button", { name: "공유 중지" }));
  expect(
    await screen.findByText("중지 대기 중이에요. 인터넷에 연결되면 중지돼요."),
  ).toBeInTheDocument();
});
