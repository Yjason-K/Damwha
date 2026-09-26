import { describe, expect, test } from "vitest";
import type { ModelRow, ModelsView } from "../api/types";
import {
  currentSttBackend,
  isVisibleByDefault,
  rowLabel,
  statusText,
  summaryLines,
} from "./rows";

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt", name: "large-v3-turbo", backend: "mlx", repoId: "r", inUseFor: [],
    installed: "yes", sizeBytes: 1_613_979_758, approxBytes: null, downloading: null, deletable: true,
    job: null,
    ...over,
  };
}

const FIXED: ModelRow[] = [
  row({ role: "diarization", name: "pyannote/speaker-diarization-community-1", backend: null, inUseFor: ["fixed"], sizeBytes: 32_838_000, deletable: false }),
  row({ role: "speaker_embedding", name: "speechbrain/spkrec-ecapa-voxceleb", backend: null, inUseFor: ["fixed"], sizeBytes: 88_997_000, deletable: false }),
  row({ role: "search_embedding", name: "BAAI/bge-m3", backend: null, inUseFor: ["fixed"], sizeBytes: 2_293_250_249, deletable: false }),
];

function view(models: ModelRow[]): ModelsView {
  return { scannedAt: "t", totalBytes: 1, pending: false, models, freeBytes: null };
}

describe("statusText", () => {
  test.each([
    [row({ downloading: { bytesDone: 4_100_000_000, bytesTotal: 9_800_000_000 } }), "받는 중 41% · 4.1 GB / 9.8 GB"], // 41.8% → 내림
    [row({ downloading: { bytesDone: 5, bytesTotal: 0 } }), "받는 중"],
    [row({}), "받음 · 1.6 GB"],
    [row({ installed: "partial", sizeBytes: 1_100_000_000 }), "일부만 받음 · 1.1 GB"],
    [row({ installed: "no", sizeBytes: null, approxBytes: 3_083_522_487 }), "안 받음 · 약 3.1 GB"],
    [row({ installed: "no", sizeBytes: null, approxBytes: null }), "안 받음"],
    [row({ installed: "unknown", sizeBytes: null }), "확인 중"],
  ])("%#", (r, text) => {
    expect(statusText(r)).toBe(text);
  });
});

describe("statusText — 대기·진행 중인 모델 job", () => {
  test.each([
    [
      row({ installed: "no", job: { id: "j1", type: "download_model", status: "queued", error: null } }),
      "받기 대기 중",
    ],
    [
      // CPU 백엔드는 진행률을 안 주기도 한다 — downloading이 null이어도 running이면 "받는 중".
      row({ installed: "no", job: { id: "j1", type: "download_model", status: "running", error: null } }),
      "받는 중",
    ],
    [row({ job: { id: "j1", type: "delete_model", status: "queued", error: null } }), "지우는 중"],
    [row({ job: { id: "j1", type: "delete_model", status: "running", error: null } }), "지우는 중"],
  ])("%#", (r, text) => {
    expect(statusText(r)).toBe(text);
  });

  test("downloading이 있으면 job 문구보다 우선한다", () => {
    const withJob = row({
      downloading: { bytesDone: 4_100_000_000, bytesTotal: 9_800_000_000 },
      job: { id: "j1", type: "download_model", status: "running", error: null },
    });
    expect(statusText(withJob)).toBe("받는 중 41% · 4.1 GB / 9.8 GB");
  });
});

test("rowLabel — 다른 백엔드 전사 모델에 CPU용/GPU용", () => {
  expect(rowLabel(row({ name: "small", backend: "faster" }), "mlx")).toBe("small · CPU용");
  expect(rowLabel(row({ name: "small", backend: "mlx" }), "faster")).toBe("small · GPU용");
  expect(rowLabel(row({ name: "small", backend: "mlx" }), "mlx")).toBe("small");
  expect(rowLabel(FIXED[1], "mlx")).toBe("화자 식별 모델");
  expect(rowLabel(row({ role: "summary", name: "mlx-community/Qwen3.5-9B-8bit", backend: null }), "mlx")).toBe("qwen3.5 9B");
});

test("isVisibleByDefault — 사용 중·받음·일부·받는 중·고정만", () => {
  expect(isVisibleByDefault(row({ installed: "no" }))).toBe(false);
  expect(isVisibleByDefault(row({ installed: "no", inUseFor: ["stt"] }))).toBe(true);
  expect(isVisibleByDefault(row({ installed: "partial" }))).toBe(true);
  expect(isVisibleByDefault(row({ installed: "no", downloading: { bytesDone: 1, bytesTotal: 2 } }))).toBe(true);
  expect(isVisibleByDefault(row({ installed: "unknown", role: "diarization", backend: null }))).toBe(true);
});

test("isVisibleByDefault — 대기·진행 중인 모델 job이 있으면 '모든 모델 보기'를 접어도 보인다", () => {
  expect(
    isVisibleByDefault(row({ installed: "no", job: { id: "j1", type: "download_model", status: "queued", error: null } })),
  ).toBe(true);
  expect(
    isVisibleByDefault(row({ installed: "no", job: { id: "j1", type: "download_model", status: "running", error: null } })),
  ).toBe(true);
  // 끝난 job은 이 규칙 대상이 아니다(installed 상태로 판단).
  expect(
    isVisibleByDefault(row({ installed: "no", job: { id: "j1", type: "download_model", status: "done", error: null } })),
  ).toBe(false);
});

test("currentSttBackend — 사용 중 전사 행의 백엔드", () => {
  expect(currentSttBackend([row({ backend: "faster", inUseFor: ["stt"] })])).toBe("faster");
  expect(currentSttBackend([row({})])).toBeNull();
});

describe("summaryLines", () => {
  const stt = row({ inUseFor: ["stt"] });
  const sum9 = row({ role: "summary", name: "mlx-community/Qwen3.5-9B-8bit", backend: null, inUseFor: ["summary"], installed: "no", sizeBytes: null, approxBytes: 10_453_442_419 });
  const lens4 = row({ role: "summary", name: "mlx-community/Qwen3.5-4B-8bit", backend: null, inUseFor: ["lens"], sizeBytes: 5_163_524_489 });

  test("전사·요약·렌즈 추출·기본 — 안 받은 줄은 처음 처리 때 받는다고 말한다", () => {
    expect(summaryLines(view([stt, sum9, lens4, ...FIXED]))).toMatchObject([
      { label: "전사", value: "large-v3-turbo · GPU", status: "받음 · 1.6 GB" },
      { label: "요약", value: "qwen3.5 9B", status: "안 받음 · 처음 회의를 처리할 때 받아요 (약 10.5 GB)" },
      { label: "렌즈 추출", value: "qwen3.5 4B", status: "받음 · 5.2 GB" },
      { label: "기본", value: "화자 분리 · 화자 식별 · 검색 임베딩", status: "모두 받음 · 2.4 GB" },
    ]);
  });

  test("요약과 렌즈가 같은 행이면 한 줄", () => {
    const both = row({ ...lens4, inUseFor: ["summary", "lens"] });
    const lines = summaryLines(view([stt, both, ...FIXED]));
    expect(lines.map((l) => l.label)).toEqual(["전사", "요약·렌즈 추출", "기본"]);
  });

  test("기본 모델 중 안 받은 것은 풀어 쓴다", () => {
    const fixed = [FIXED[0], { ...FIXED[1], installed: "no" as const, sizeBytes: null }, FIXED[2]];
    const last = summaryLines(view([stt, ...fixed])).at(-1);
    expect(last).toMatchObject({ label: "기본", value: "화자 분리 · 화자 식별 · 검색 임베딩", status: "화자 식별 모델 안 받음" });
  });

  test("렌즈 모델이 둘이면(BE·worker 값이 다름) 두 줄이 따로 나온다", () => {
    const lensBe = row({ role: "summary", name: "mlx-community/Qwen3.5-4B-8bit", backend: null, inUseFor: ["lens"], sizeBytes: 5_163_524_489 });
    const lensWorker = row({ role: "summary", name: "mlx-community/Qwen3.5-9B-8bit", backend: null, inUseFor: ["lens"], installed: "no", sizeBytes: null, approxBytes: 10_453_442_419 });
    const lines = summaryLines(view([stt, lensBe, lensWorker, ...FIXED]));
    expect(lines.filter((l) => l.label === "렌즈 추출")).toHaveLength(2);
  });

  test("CPU 전사", () => {
    const cpu = row({ backend: "faster", inUseFor: ["stt"] });
    expect(summaryLines(view([cpu, ...FIXED]))[0].value).toBe("large-v3-turbo · CPU");
  });

  test("미리 받기가 대기·진행 중이면 '처음 회의를 처리할 때 받아요' 대신 job 문구를 쓴다", () => {
    const queued = row({
      ...sum9,
      job: { id: "j1", type: "download_model", status: "queued", error: null },
    });
    const lines = summaryLines(view([stt, queued, lens4, ...FIXED]));
    expect(lines.find((l) => l.label === "요약")?.status).toBe("받기 대기 중");
  });
});
