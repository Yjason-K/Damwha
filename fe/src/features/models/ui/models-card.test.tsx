import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import { HfTokenGateProvider } from "@/features/hf-token/ui/hf-token-gate";
import type { HfTokenState } from "@/features/hf-token/model/types";
import { MODELS_QUERY_KEY } from "../api/models";
import type { ModelRow, ModelsView } from "../api/types";
import { ModelsCard } from "./models-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt",
    name: "large-v3-turbo",
    backend: "mlx",
    repoId: "r",
    inUseFor: [],
    installed: "yes",
    sizeBytes: 1_613_979_758,
    approxBytes: null,
    downloading: null,
    deletable: true,
    job: null,
    ...over,
  };
}

const VIEW: ModelsView = {
  scannedAt: "2026-09-25T10:00:00.000000Z",
  totalBytes: 9_200_000_000,
  pending: false,
  freeBytes: null,
  models: [
    row({ inUseFor: ["stt"], deletable: false }),
    row({
      name: "large-v3",
      installed: "no",
      sizeBytes: null,
      approxBytes: 3_083_522_487,
    }),
    row({
      role: "summary",
      name: "mlx-community/Qwen3.5-4B-8bit",
      backend: null,
      inUseFor: ["summary", "lens"],
      sizeBytes: 5_163_524_489,
      deletable: false,
    }),
    row({
      role: "diarization",
      name: "pyannote/speaker-diarization-community-1",
      backend: null,
      inUseFor: ["fixed"],
      sizeBytes: 32_800_000,
      deletable: false,
    }),
    row({
      role: "speaker_embedding",
      name: "speechbrain/spkrec-ecapa-voxceleb",
      backend: null,
      inUseFor: ["fixed"],
      sizeBytes: 88_900_000,
      deletable: false,
    }),
    row({
      role: "search_embedding",
      name: "BAAI/bge-m3",
      backend: null,
      inUseFor: ["fixed"],
      sizeBytes: 2_293_250_249,
      deletable: false,
    }),
  ],
};

function renderCard(view: ModelsView) {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: view } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelsCard />
    </QueryClientProvider>,
  );
}

test("모델 카드는 보관함만 — 합계와 목록을 보이고, 지금 쓰는 모델 요약은 처리 방식 섹션이 맡는다", async () => {
  renderCard(VIEW);
  expect(await screen.findByText("받은 모델 합계 9.2 GB")).toBeTruthy();
  expect(screen.getByRole("region", { name: "받아 둔 모델" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: /쓰는 모델/ })).toBeNull();
});

test("목록은 기본으로 사용 중·받은 것만, 펼치면 나머지", async () => {
  renderCard(VIEW);
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).queryByText("large-v3")).toBeNull();
  expect(within(list).getAllByText("사용 중").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "모든 모델 보기" }));
  expect(within(list).getByText("large-v3")).toBeTruthy();
  expect(within(list).getByText("약 3.1 GB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "접기" })).toBeTruthy();
});

test("고정 모델은 기본 모델 묶음에 사용자 이름으로 나온다", async () => {
  renderCard(VIEW);
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).getByText("기본 모델 · 항상 사용")).toBeTruthy();
  expect(within(list).getByText("화자 식별 모델")).toBeTruthy();
  expect(within(list).queryByText(/pyannote|speechbrain|bge/i)).toBeNull();
});

test("불러오는 동안 안내 문구를 보인다", () => {
  vi.spyOn(apiClient, "get").mockReturnValue(new Promise(() => {}));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ModelsCard />
    </QueryClientProvider>,
  );
  expect(screen.getByText("모델 상태를 불러오는 중…")).toBeTruthy();
});

test("조회에 실패하면 오류 문구를 보인다", async () => {
  vi.spyOn(apiClient, "get").mockRejectedValue(new Error("network"));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ModelsCard />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("모델 상태를 불러오지 못했어요."),
  ).toBeTruthy();
});

test("아직 스캔 전이면 안내 문구만", async () => {
  renderCard({
    scannedAt: null,
    totalBytes: null,
    pending: false,
    freeBytes: null,
    models: VIEW.models,
  });
  expect(
    await screen.findByText(
      "모델 상태를 아직 확인하지 못했어요. 작업 처리기가 준비되면 보여요.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "받아 둔 모델" })).toBeNull();
});

test("안 받은 모델에 받기 → POST /models/download", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { job: { id: "job_9" } } } as never);
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models, row({ name: "medium", installed: "no", sizeBytes: null, approxBytes: 1_524_927_044, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "모든 모델 보기" }));
  fireEvent.click(screen.getByRole("button", { name: "medium 받기" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/models/download", { role: "stt", name: "medium", backend: "mlx" }));
});

test("받는 중이면 취소 → POST /models/cancel", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCard({ ...VIEW, freeBytes: null, models: [row({ name: "small", installed: "no", sizeBytes: null, downloading: { bytesDone: 1, bytesTotal: 10 }, job: { id: "job_3", type: "download_model", status: "running", error: null } }), ...VIEW.models.slice(1)] });
  fireEvent.click(await screen.findByRole("button", { name: "small 받기 취소" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/models/cancel", { jobId: "job_3" }));
});

test("삭제는 확인을 거친다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models, row({ role: "summary", name: "mlx-community/Qwen3.5-27B-8bit", backend: null, sizeBytes: 29_528_168_817, installed: "yes", deletable: true, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "qwen3.5 27B 삭제" }));
  expect(screen.getByText("qwen3.5 27B를 지울까요? 29.5 GB가 비워져요. 다시 쓰려면 다시 받아야 해요.")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/models/delete", { role: "summary", name: "mlx-community/Qwen3.5-27B-8bit" }));
});

test("사용 중인 모델은 삭제 버튼 없이 '사용 중' 배지만 — 같은 뜻의 사유를 겹쳐 적지 않는다", async () => {
  renderCard({ ...VIEW, freeBytes: null });
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).queryByRole("button", { name: /large-v3-turbo 삭제/ })).toBeNull();
  expect(within(list).getAllByText("사용 중").length).toBeGreaterThan(0);
  expect(within(list).queryByText("지금 설정에서 쓰고 있어요")).toBeNull();
});

test("실패한 받기는 코드별 문구, 취소는 표시 없음", async () => {
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models,
    row({ name: "medium", installed: "no", sizeBytes: null, job: { id: "j", type: "download_model", status: "failed", error: { code: "DISK_FULL", message: "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB." } } }),
    row({ name: "base", installed: "no", sizeBytes: null, job: { id: "k", type: "download_model", status: "failed", error: { code: "download_cancelled", message: "" } } }),
  ] });
  fireEvent.click(await screen.findByRole("button", { name: "모든 모델 보기" }));
  expect(screen.getByText("디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB.")).toBeTruthy();
  expect(screen.queryByText(/취소/)).toBeNull();
});

test("409는 행 아래 한 줄로 보인다", async () => {
  vi.spyOn(apiClient, "post").mockRejectedValue(new ApiError(409, "지금 설정에서 쓰고 있어요.", "model_in_use_by_settings"));
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models, row({ name: "small", installed: "yes", deletable: true, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "small 삭제" }));
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  expect(await screen.findByText("지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요.")).toBeTruthy();
});

test("409 문구는 그 행 상태가 바뀌면(성공적 삭제 등) 저절로 사라진다", async () => {
  // 회귀: 이전에는 삭제·취소·받기가 하나의 conflict state를 공유하지 않고 자기 액션이 끝나도
  // 지워지지 않아, 행이 이미 다른 상태로 바뀐 뒤에도 낡은 409 문구가 남았다. 지금은 오류를 그
  // 당시 행 상태({installed, job.id})와 함께 담아 두고, 렌더마다 지금 행의 그 값과 비교한다 —
  // 클릭 없이 캐시만 바뀌어도(다른 탭·폴링에서 온 갱신) 낡은 문구는 렌더 중 파생으로 사라진다.
  vi.spyOn(apiClient, "post").mockRejectedValue(new ApiError(409, "지금 설정에서 쓰고 있어요.", "model_in_use_by_settings"));
  const modelsWithSmall = [...VIEW.models, row({ name: "small", installed: "yes", deletable: true, job: null })];
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { ...VIEW, freeBytes: null, models: modelsWithSmall } } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ModelsCard />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "small 삭제" }));
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  expect(await screen.findByText("지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요.")).toBeTruthy();

  // installed는 그대로 "yes"로 둬(행이 목록에서 사라져 마운트 해제되는 우연이 아니게) job만 새로
  // 생겼다고 캐시를 바꾼다 — sig(`installed:job.id`)가 달라지므로, 같은 컴포넌트가 계속 떠 있는
  // 채로도 오래된 409 문구는 렌더 중 파생으로 사라져야 한다.
  act(() => {
    qc.setQueryData(MODELS_QUERY_KEY, (prev: ModelsView | undefined) =>
      prev && {
        ...prev,
        models: prev.models.map((m) =>
          m.name === "small"
            ? {
                ...m,
                job: { id: "job_after", type: "download_model" as const, status: "running" as const, error: null },
              }
            : m,
        ),
      },
    );
  });
  // 행이 마운트 해제된 게 아니라 여전히 같은 행임을 보인다 — installed는 계속 yes라 행은 남고,
  // 새 job이 진행 중이라 이제 "취소" 버튼이 뜬다.
  expect(await screen.findByRole("button", { name: "small 받기 취소" })).toBeTruthy();
  expect(
    screen.queryByText("지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요."),
  ).toBeNull();
});

test("남은 용량보다 큰 모델은 받기 옆에 경고", async () => {
  // VIEW.models[1]("large-v3", 안 받음, approxBytes 3.08 GB)도 freeBytes 1 GB보다 커서 같은 경고
  // 문구를 낸다 — 브리프대로 그 행을 그대로 두고 같은 이름·용량의 행을 하나 더 얹으면(원문
  // 그대로) 경고가 두 번 나와 getByText가 항상 실패한다(구현과 무관). 그 행을 빼고 새 행 하나만
  // 넣어 경고가 정확히 한 번 뜨는지를 본다 — 검증 내용(문구·용량)은 브리프와 같다.
  renderCard({ ...VIEW, freeBytes: 1_000_000_000, models: [VIEW.models[0], ...VIEW.models.slice(2), row({ name: "medium", installed: "no", sizeBytes: null, approxBytes: 3_083_522_487, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "모든 모델 보기" }));
  expect(screen.getByText("남은 용량(1.0 GB)보다 커요")).toBeTruthy();
});

const HF_ABSENT: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

function diarizationRow(over: Partial<ModelRow> = {}): ModelRow {
  return row({
    role: "diarization",
    name: "pyannote/speaker-diarization-community-1",
    backend: null,
    inUseFor: ["fixed"],
    installed: "no",
    sizeBytes: null,
    approxBytes: 32_800_000,
    deletable: false,
    job: null,
    ...over,
  });
}

function renderCardWithGate(view: ModelsView, tokenState: HfTokenState) {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: view } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HfTokenGateProvider view={{ kind: "ready", state: tokenState }} send={vi.fn()}>
        <ModelsCard />
      </HfTokenGateProvider>
    </QueryClientProvider>,
  );
}

test("화자 분리 모델 받기는 토큰 게이트를 거친다 (토큰 없으면 요청 없이 다이얼로그)", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCardWithGate(
    { ...VIEW, freeBytes: null, models: [...VIEW.models.slice(0, 3), diarizationRow(), ...VIEW.models.slice(4)] },
    HF_ABSENT,
  );
  fireEvent.click(await screen.findByRole("button", { name: "화자 분리 모델 받기" }));
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "허깅페이스 토큰이 필요해요" })).toBeInTheDocument(),
  );
  // mutate()는 TanStack Query 내부에서 비동기로 mutationFn을 부른다 — 클릭 직후 동기 단언은
  // 게이트를 우회해 다이얼로그도 뜨고 요청도 나가는 회귀를 못 잡는다(펜딩 마이크로태스크가 아직
  // 안 돌아서). 한 틱 흘려보낸 뒤에 "요청 없음"을 확인해야 "다이얼로그 + 요청"을 함께 잡는다.
  await new Promise((r) => setTimeout(r, 0));
  expect(post).not.toHaveBeenCalled();
});

test("토큰이 있으면 화자 분리 모델 받기는 바로 요청한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCardWithGate(
    { ...VIEW, freeBytes: null, models: [...VIEW.models.slice(0, 3), diarizationRow(), ...VIEW.models.slice(4)] },
    { ...HF_ABSENT, status: "present", masked: "hf_****…****4567" },
  );
  fireEvent.click(await screen.findByRole("button", { name: "화자 분리 모델 받기" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/models/download", { role: "diarization", name: "pyannote/speaker-diarization-community-1" }),
  );
  expect(post).toHaveBeenCalledTimes(1);
});

test("모델 사용 조건에 동의해야 하면 문구와 기존 사용 조건 페이지 열기 동작을 보인다", async () => {
  renderCardWithGate(
    {
      ...VIEW,
      freeBytes: null,
      models: [
        ...VIEW.models.slice(0, 3),
        diarizationRow({
          job: {
            id: "g1",
            type: "download_model",
            status: "failed",
            error: { code: "hf_gate_not_accepted", message: "" },
          },
        }),
        ...VIEW.models.slice(4),
      ],
    },
    HF_ABSENT,
  );
  // 기존 HfFailureAction(action="accept")을 그대로 재사용한다 — 손으로 다시 짠 "사용 조건 페이지
  // 열기" 버튼을 두지 않는다. 이 컴포넌트는 게이트 Provider가 "ready"일 때만 스스로를 보인다.
  expect(await screen.findByText("모델 사용 조건에 동의해야 받을 수 있어요.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "사용 조건 페이지 열기" })).toBeTruthy();
});
