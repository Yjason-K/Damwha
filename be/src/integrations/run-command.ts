import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { searchDirs } from './find-executable';

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOptions = {
  exec?: typeof execFile;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

const CLIENT_BINS = new Set(['claude', 'codex']);

/**
 * npm으로 깐 claude·codex는 `#!/usr/bin/env node` 스크립트다. Finder에서 뜬 앱의 PATH(/usr/bin:/bin:…)에는 node가 없어
 * 찾은 실행 파일을 돌려도 `env: node: No such file or directory`로 끝난다. 그 바이너리가 있는 디렉터리(nvm이면 node도
 * 거기 있다)와 알려진 설치 위치를 자식 PATH 앞에 붙인다. 셸 탐침에는 붙이지 않는다 — 로그인 셸 PATH를 물을 때
 * 우리가 넣은 디렉터리가 섞여 나오면 on_path가 거짓으로 참이 된다.
 */
function childEnv(file: string, home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (!CLIENT_BINS.has(basename(file))) return undefined;
  const dirs = [dirname(file), ...searchDirs(home), ...(env.PATH ?? '').split(':')].filter(Boolean);
  return { ...env, PATH: [...new Set(dirs)].join(':') };
}

/**
 * 셸 없이 고정 인자 배열로 실행한다 (spec §2.7). 비정상 종료(종료 코드 있음)는 reject하지 않고 돌려준다 — `mcp get`의
 * "없음"이 종료 코드 1이기 때문이다. 실행 파일이 없거나, 15초를 넘기거나, 출력이 64KB를 넘으면 reject한다.
 */
export function runCommand(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { exec = execFile, home = homedir(), env = process.env } = opts;
  const childVars = childEnv(file, home, env);
  return new Promise((resolve, reject) => {
    exec(
      file,
      args,
      { timeout: 15_000, maxBuffer: 65_536, encoding: 'utf8', ...(childVars && { env: childVars }) },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === 'number' && !(err as { killed?: boolean }).killed) {
          return resolve({ code, stdout, stderr });
        }
        reject(err);
      },
    );
  });
}
