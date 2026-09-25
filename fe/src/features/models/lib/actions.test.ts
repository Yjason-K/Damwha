import { describe, expect, test } from "vitest";
import type { ModelRow } from "../api/types";
import { conflictText, exceedsFreeSpace, jobErrorText, rowAction } from "./actions";

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt", name: "small", backend: "mlx", repoId: "r", inUseFor: [], installed: "no",
    sizeBytes: null, approxBytes: 481_000_000, downloading: null, deletable: true, job: null, ...over,
  };
}
const job = (over: Partial<NonNullable<ModelRow["job"]>>) => ({
  id: "job_1", type: "download_model" as const, status: "queued" as const, error: null, ...over,
});

describe("rowAction", () => {
  test.each([
    [row({}), "download"],
    [row({ installed: "partial" }), "redownload"],
    [row({ downloading: { bytesDone: 1, bytesTotal: 2 } }), "cancel"],
    [row({ job: job({ status: "queued" }) }), "cancel"],
    [row({ job: job({ status: "running" }) }), "cancel"],
    [row({ installed: "yes" }), "delete"],
    [row({ installed: "yes", deletable: false, inUseFor: ["stt"] }), null],
    [row({ installed: "yes", deletable: false, role: "diarization", backend: null, inUseFor: ["fixed"] }), null],
    [row({ installed: "unknown" }), null],
    [row({ installed: "yes", job: job({ type: "delete_model", status: "running" }) }), null],
  ])("%#", (r, kind) => {
    expect(rowAction(r).kind).toBe(kind);
  });

  test("사용 중이라 못 지우면 이유를 준다, 고정 모델은 이유 없음", () => {
    expect(rowAction(row({ installed: "yes", deletable: false, inUseFor: ["stt"] })).reason).toBe("지금 설정에서 쓰고 있어요");
    expect(rowAction(row({ installed: "yes", deletable: false, inUseFor: [] })).reason).toBe("처리 중인 작업이 쓰고 있어요");
    expect(rowAction(row({ installed: "yes", deletable: false, role: "search_embedding", backend: null, inUseFor: ["fixed"] })).reason).toBeNull();
  });
});

describe("jobErrorText", () => {
  const failed = (code: string, type: "download_model" | "delete_model" = "download_model", message = "") =>
    row({ job: job({ type, status: "failed", error: { code, message } }) });

  test("코드로 고른다", () => {
    expect(jobErrorText(failed("DISK_FULL", "download_model", "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB.")))
      .toEqual({ text: "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB.", accept: false });
    expect(jobErrorText(failed("hf_token_invalid"))?.text).toBe("허깅페이스 토큰이 유효하지 않아 받지 못했어요. 토큰을 확인해 주세요.");
    expect(jobErrorText(failed("hf_gate_not_accepted"))).toEqual({ text: "모델 사용 조건에 동의해야 받을 수 있어요.", accept: true });
    expect(jobErrorText(failed("model_in_use", "delete_model"))?.text).toBe("처리 중인 작업이 쓰고 있어 지우지 않았어요.");
    expect(jobErrorText(failed("model_download_failed"))?.text).toBe("받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요.");
    expect(jobErrorText(failed("io_error", "delete_model"))?.text).toBe("지우지 못했어요.");
  });

  test("취소·성공·진행 중은 표시하지 않는다", () => {
    expect(jobErrorText(failed("download_cancelled"))).toBeNull();
    expect(jobErrorText(row({ job: job({ status: "done" }) }))).toBeNull();
    expect(jobErrorText(row({ job: job({ status: "running" }) }))).toBeNull();
    expect(jobErrorText(row({}))).toBeNull();
  });

  test("받은 뒤에는 옛 받기 실패를 보이지 않는다", () => {
    expect(jobErrorText(row({ installed: "yes", job: job({ status: "failed", error: { code: "model_download_failed", message: "" } }) }))).toBeNull();
  });
});

test("conflictText — 409 코드", () => {
  expect(conflictText("model_in_use_by_settings")).toBe("지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요.");
  expect(conflictText("model_in_use_by_job")).toBe("처리 중인 작업이 쓰고 있어요. 끝난 뒤 지울 수 있어요.");
  expect(conflictText("model_busy")).toBe("이 모델에 대한 다른 작업이 진행 중이에요.");
  expect(conflictText("other")).toBeNull();
});

test("exceedsFreeSpace — 안 받은 모델의 대략 용량이 남은 용량보다 클 때만", () => {
  expect(exceedsFreeSpace(row({ approxBytes: 10 }), 5)).toBe(true);
  expect(exceedsFreeSpace(row({ approxBytes: 10 }), 50)).toBe(false);
  expect(exceedsFreeSpace(row({ approxBytes: null }), 5)).toBe(false);
  expect(exceedsFreeSpace(row({ approxBytes: 10 }), null)).toBe(false);
  expect(exceedsFreeSpace(row({ installed: "yes", approxBytes: 10 }), 5)).toBe(false);
});
