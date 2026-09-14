import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { makeSink, sinkTails } from "../src/api-process";

const RED = "\x1b[31m";
const RESET = "\x1b[39m";

/** fs.WriteStream.write는 비동기라 close() 직후 바로 읽으면 아직 디스크에 없을 수 있다.
 *  실제 스트림 객체를 makeSink가 밖으로 안 내놓으므로 'finish'를 직접 못 걸고, 내용이
 *  나타날 때까지 짧게 폴링한다 — worker.ts:143의 stop() 폴링과 같은 방식이다. */
async function waitForContent(file: string, timeoutMs = 2_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      if (content.length > 0) return content;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${file}에 내용이 쓰이길 기다리다 타임아웃했다`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

describe("makeSink — 파일 쓰기 경로에서만 ANSI를 벗긴다 (Task 9)", () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("로그 파일에는 ANSI가 빠진 텍스트가, tail()·stdoutTail()에는 원본이 그대로 남는다", async () => {
    // worker의 진행 바·NestJS Logger 색상이 그대로면 로그 파일에 제어문자가 글자로 남는다
    // (logs.ts의 stripAnsi 근거). 반대로 화면에 올리는 tail까지 벗기면 failureBlock·
    // lastMeaningfulLine이 이미 벗기는 Phase 1의 stderr.test.ts 전제(원본 입력)가 달라진다 —
    // 그래서 이 테스트는 파일과 tail을 각각 따로 확인한다.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-sink-"));
    const logFile = path.join(dir, "api.log");
    const sink = makeSink(logFile);

    sink.write(`${RED}stdout 색상 줄${RESET}\n`, false);
    sink.write(`${RED}stderr 색상 줄${RESET}\n`, true);
    sink.close();

    const onDisk = await waitForContent(logFile);
    expect(onDisk).toBe("stdout 색상 줄\nstderr 색상 줄\n");
    expect(onDisk).not.toContain("\x1b");

    // 변이 검증: 여기서 stripAnsi를 tail 쪽에도 걸면 아래 두 기대가 깨진다.
    expect(sink.stdoutTail()).toBe(`${RED}stdout 색상 줄${RESET}\n`);
    expect(sink.tail()).toBe(`${RED}stderr 색상 줄${RESET}\n`);
  });

  it("logFile이 없으면(diskless sink) 여전히 tail만 원본으로 쌓인다", () => {
    // out이 아예 없는 경로(logFile 미지정)에서 stripAnsi 도입이 tail 쪽 동작을 건드리지
    // 않는다는 것을 고정한다 — 기존 sinkTails 테스트와 같은 전제.
    const sink = makeSink();
    sink.write(`${RED}색상${RESET}\n`, true);
    expect(sink.tail()).toBe(`${RED}색상${RESET}\n`);
  });
});
