import { describe, expect, it } from "vitest";
import { makeSink, sinkTails } from "../src/api-process";

/**
 * launchDev·launchPackaged 둘 다 makeSink()로 청크를 쌓고 sinkTails()로 ApiHandle이
 * 노출할 이름에 연결한다. 이전엔 그 두 런처가 이 매핑을 각자 복붙해 뒀는데, 리뷰
 * 한 번이 `stdoutTail: sink.stdoutTail`을 `sink.tail`로 되돌려도(원래 나던 버그 그대로)
 * 타입이 그대로 맞아 tsc도, judgeAfterProbe를 가짜 handle로 부르는 기존 테스트도
 * 못 잡았다 — 그 테스트들은 이미 옳게 분리된 handle을 손으로 만들 뿐, makeSink가
 * 실제로 청크를 어디에 쌓고 그 축적기가 어느 이름에 연결되는지는 아무도 실행하지
 * 않았다. 이 파일은 그 배선 자체를 고정한다.
 */
describe("makeSink — 청크를 스트림별로 분리해 쌓는다", () => {
  it("isError: false인 청크는 stdoutTail()에만 쌓인다", () => {
    const sink = makeSink();

    sink.write("stdout 줄\n", false);

    expect(sink.stdoutTail()).toContain("stdout 줄");
    expect(sink.tail()).not.toContain("stdout 줄");
  });

  it("isError: true인 청크는 tail()(stderr)에만 쌓인다", () => {
    const sink = makeSink();

    sink.write("stderr 줄\n", true);

    expect(sink.tail()).toContain("stderr 줄");
    expect(sink.stdoutTail()).not.toContain("stderr 줄");
  });
});

describe("sinkTails — ApiHandle 배선 고정", () => {
  it("stdout 청크는 stdoutTail()에, stderr 청크는 stderrTail()에 각각 간다", () => {
    // makeSink → sinkTails 순서는 launchDev·launchPackaged가 실제로 handle을 만들 때
    // 쓰는 것과 똑같다. 이 둘이 만나는 지점 하나만 지키면 두 런처의 배선이 함께
    // 보장된다 — sinkTails 안의 매핑이 뒤바뀌면(원래 버그) 아래 기대가 깨진다.
    const sink = makeSink();
    sink.write("stdout 줄\n", false);
    sink.write("stderr 줄\n", true);

    const tails = sinkTails(sink);

    expect(tails.stdoutTail()).toContain("stdout 줄");
    expect(tails.stdoutTail()).not.toContain("stderr 줄");
    expect(tails.stderrTail()).toContain("stderr 줄");
    expect(tails.stderrTail()).not.toContain("stdout 줄");
  });
});
