import { afterEach, expect, test, vi } from "vitest";

import { ApiError, apiClient } from "@/shared/api/client";

afterEach(() => vi.restoreAllMocks());

/** 507 DISK_FULL 실패를 흉내 내는 axios 어댑터. 실제 네트워크를 타지 않는다. */
function diskFullAdapter(free: number, needed: number | null) {
  return vi.fn(async (config) =>
    Promise.reject({
      isAxiosError: true,
      message: "Request failed with status code 507",
      response: {
        status: 507,
        statusText: "Insufficient Storage",
        data: { code: "DISK_FULL", free, needed },
        headers: {},
        config,
      },
      config,
      toJSON: () => ({}),
    }),
  );
}

test("업로드 507 — needed가 null이면 남은 용량만 말한다 (be의 disk-full.filter.ts 계약)", async () => {
  const adapter = diskFullAdapter(1_200_000_000, null);
  const promise = apiClient.post("/meetings", new FormData(), { adapter });
  await expect(promise).rejects.toBeInstanceOf(ApiError);
  await promise.catch((e: ApiError) => {
    expect(e.statusCode).toBe(507);
    expect(e.code).toBe("DISK_FULL");
    expect(e.message).toBe(
      "디스크 공간이 부족해요 — 남은 용량 1.2 GB. 다른 파일을 정리해 공간을 만든 뒤 다시 올려 주세요.",
    );
  });
});

test("모델 다운로드 경로처럼 needed를 아는 507이면 둘 다 말한다", async () => {
  const adapter = diskFullAdapter(1_200_000_000, 12_300_000_000);
  const promise = apiClient.post("/meetings", new FormData(), { adapter });
  await promise.catch((e: ApiError) => {
    expect(e.message).toBe(
      "디스크 공간이 부족해요 — 남은 용량 1.2 GB, 필요한 용량 12.3 GB. 다른 파일을 정리해 공간을 만든 뒤 다시 올려 주세요.",
    );
  });
});

test("바이트 단위 기준은 1000이다 — worker의 format_bytes와 같은 기준이어야 같은 디스크가 같은 숫자로 보인다", async () => {
  const adapter = diskFullAdapter(999, null);
  const promise = apiClient.post("/meetings", new FormData(), { adapter });
  await promise.catch((e: ApiError) => {
    expect(e.message).toContain("남은 용량 999 B");
  });
});

/** DISK_FULL 밖의 실패도 흉내 내는 axios 어댑터 — `{ statusCode, code, message }` 모양(DemoReadOnlyGuard와 같음). */
function errorAdapter(status: number, code: string, message: string) {
  return vi.fn(async (config) =>
    Promise.reject({
      isAxiosError: true,
      message: `Request failed with status code ${status}`,
      response: {
        status,
        statusText: "Error",
        data: { statusCode: status, code, message },
        headers: {},
        config,
      },
      config,
      toJSON: () => ({}),
    }),
  );
}

test("오류 본문의 code를 ApiError에 싣는다 (DISK_FULL 밖에서도)", async () => {
  const adapter = errorAdapter(409, "model_busy", "이 모델에 대한 다른 작업이 진행 중이에요.");
  const promise = apiClient.post("/models/delete", { role: "stt", name: "small" }, { adapter });
  await expect(promise).rejects.toBeInstanceOf(ApiError);
  await promise.catch((e: ApiError) => {
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe("model_busy");
    expect(e.message).toBe("이 모델에 대한 다른 작업이 진행 중이에요.");
  });
});
