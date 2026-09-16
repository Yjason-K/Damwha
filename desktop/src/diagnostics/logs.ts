import * as fs from "fs";
import { ANSI_SGR } from "./stderr";

/** 10 MB × 3세대. 근거는 결과 문서에 남긴다 — worker의 진행 바가 로그를 빠르게 불린다. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_GENERATIONS = 3;

export interface RotateIo {
  /** 없으면 음수. */
  size(p: string): number;
  rename(from: string, to: string): void;
  remove(p: string): void;
}

const realIo: RotateIo = {
  size: (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return -1;
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  remove: (p) => fs.rmSync(p, { force: true }),
};

/**
 * 기동 시점에 한 번 부른다. 스트림이 열린 뒤 파일을 옮기면 열린 핸들이 옮겨진 파일을 계속
 * 가리키므로, 회전은 자식을 띄우기 **전에** 해야 한다.
 */
export function rotateIfNeeded(
  file: string,
  maxBytes: number = LOG_MAX_BYTES,
  generations: number = LOG_GENERATIONS,
  io: RotateIo = realIo,
): void {
  try {
    const size = io.size(file);
    if (size < 0 || size < maxBytes) return;

    // 가장 오래된 것부터 지우고 뒤에서 앞으로 밀어야 덮어쓰지 않는다.
    io.remove(`${file}.${generations}`);
    for (let i = generations - 1; i >= 1; i -= 1) {
      if (io.size(`${file}.${i}`) >= 0) io.rename(`${file}.${i}`, `${file}.${i + 1}`);
    }
    io.rename(file, `${file}.1`);
  } catch {
    // 로그를 못 돌리는 것은 앱이 죽을 이유가 아니다. 다음 기동에 다시 시도한다.
  }
}

/**
 * worker는 진행 바와 로그가 같은 stderr를 쓰고(console.install_logging), NestJS Logger도
 * TTY가 아닌 stderr에 색상을 쓴다. 파일에 그대로 넣으면 제어문자가 글자로 남는다.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}
