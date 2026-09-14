import * as fs from "fs";
import * as path from "path";
import { stripAnsi } from "../diagnostics/logs";

const TAIL_LIMIT = 8_000;

/**
 * 자식의 stdout·stderr 싱크. 로그 파일에 쓰고, 판정과 화면에 쓸 꼬리를 스트림별로 쌓는다. API·worker·embed·postmaster
 * 런처가 같은 싱크를 쓴다 — 두 스트림을 나누는 규칙이 런처마다 갈라지지 않게 한곳에 둔다.
 */
export function makeSink(logFile?: string) {
  let tail = "";
  // stderr 꼬리와 별도로 쌓는다 — 합치면 평범한 stdout 로그가 lastMeaningfulLine 같은
  // "실패 원인" 판정을 오염시킨다. ProcessHandle.stdoutTail(process/handle.ts)의 doc 코멘트에 이유가 있다.
  let stdoutTail = "";
  let closed = false;
  let out: fs.WriteStream | undefined;
  if (logFile !== undefined) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.createWriteStream(logFile, { flags: "a" });
    // 디스크가 차거나 권한이 없으면 스트림이 'error'를 낸다. 리스너가 없으면 그
    // 예외가 앱을 죽인다 — 로그를 못 쓰는 것은 앱이 죽을 이유가 아니다.
    out.on("error", () => {
      out = undefined;
    });
  }
  return {
    write(chunk: Buffer | string, isError: boolean) {
      const text = chunk.toString();
      // 파일에만 벗긴다. worker는 진행 바와 로그가 같은 stderr를 쓰고(console.install_logging),
      // NestJS Logger도 TTY가 아닌 stderr에 색상을 쓴다 — 그대로 두면 제어문자가 글자로 남는다.
      out?.write(stripAnsi(text));
      if (isError) tail = (tail + text).slice(-TAIL_LIMIT);
      else stdoutTail = (stdoutTail + text).slice(-TAIL_LIMIT);
    },
    tail: () => tail,
    stdoutTail: () => stdoutTail,
    // 'error'와 'exit' 양쪽에서 불린다. end()를 두 번 부르면
    // ERR_STREAM_WRITE_AFTER_END가 나므로 한 번만 닫는다.
    close() {
      if (closed) return;
      closed = true;
      out?.end();
    },
  };
}

/**
 * makeSink()가 쌓은 두 축적기를 ProcessHandle이 노출할 이름(stderrTail/stdoutTail)에
 * 연결한다. launchDev·launchPackaged가 이 매핑을 각자 return 객체에 복붙해 두면,
 * 복붙 한 번의 실수로 `stdoutTail: sink.stdoutTail`이 `sink.tail`로 뒤바뀌어도
 * 타입은 그대로 맞는다 — 실제로 그 사고가 한 번 났고 리뷰도, tsc도 못 잡았다.
 * 매핑을 이 함수 하나로 모으면 여기 하나만 테스트해도 두 런처의 배선이 함께
 * 보장된다.
 */
export function sinkTails(sink: { tail(): string; stdoutTail(): string }): {
  stderrTail(): string;
  stdoutTail(): string;
} {
  return { stderrTail: sink.tail, stdoutTail: sink.stdoutTail };
}
