import { describe, expect, it } from "vitest";
import { CAUSES } from "../../src/diagnostics/causes";

describe("diskFull", () => {
  it("남은 용량과 필요한 용량을 둘 다 말한다", () => {
    expect(CAUSES.diskFull.text("1.2 GB", "12.3 GB"))
      .toBe("디스크 공간이 부족해요 — 남은 용량 1.2 GB, 필요한 용량 12.3 GB.");
  });

  it("worker가 낸 사유 문자열을 자기 것으로 알아본다", () => {
    // worker의 disk.py가 만드는 문구와 이 match가 어긋나면 화면에 사유가 안 뜬다
    const fromWorker = "디스크 공간이 부족해요 — 남은 용량 1.2 GB, 필요한 용량 12.3 GB.";
    expect(CAUSES.diskFull.match.test(fromWorker)).toBe(true);
  });
});
