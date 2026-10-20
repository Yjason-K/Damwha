import { execFile } from 'node:child_process';

export type RunResult = { code: number; stdout: string; stderr: string };

/**
 * 셸 없이 고정 인자 배열로 실행한다 (spec §2.7). 비정상 종료(종료 코드 있음)는 reject하지 않고 돌려준다 — `mcp get`의
 * "없음"이 종료 코드 1이기 때문이다. 실행 파일이 없거나, 15초를 넘기거나, 출력이 64KB를 넘으면 reject한다.
 */
export function runCommand(file: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 65_536, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code === 'number' && !(err as { killed?: boolean }).killed) {
        return resolve({ code, stdout, stderr });
      }
      reject(err);
    });
  });
}
