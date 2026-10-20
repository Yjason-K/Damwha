import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { RunResult } from './run-command';

export type FindDeps = {
  home: string;
  shell: string | undefined;
  isExecutable(path: string): Promise<boolean>;
  run(file: string, args: string[]): Promise<RunResult>;
};

// 셸 인자로 쓰이므로 목록에 없는 이름은 받지 않는다 (타입이 이미 좁히지만 런타임에서도 고정).
const SHELLS = new Set(['/bin/zsh', '/bin/bash']);

/**
 * 앱이 Finder에서 떠서 API 프로세스 PATH에 사용자 셸 PATH가 없을 수 있다. 알려진 설치 위치를 먼저 보고, 없으면
 * 사용자 로그인 셸이 zsh·bash일 때만 `command -v`로 묻는다 (spec §2.7). 어느 쪽이든 절대 경로의 실행 파일만 돌려준다.
 */
export async function findExecutable(name: 'claude' | 'codex', deps: FindDeps): Promise<string | null> {
  const dirs = [`${deps.home}/.local/bin`, `${deps.home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const p = `${dir}/${name}`;
    if (await deps.isExecutable(p)) return p;
  }

  if (!deps.shell || !SHELLS.has(deps.shell)) return null;
  try {
    const r = await deps.run(deps.shell, ['-lc', `command -v ${name}`]);
    if (r.code !== 0) return null;
    // 로그인 셸 rc가 찍는 잡음이 앞에 올 수 있어 마지막 줄을 본다.
    const line = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (isAbsolute(line) && (await deps.isExecutable(line))) return line;
  } catch {
    // 셸 실행 실패는 못 찾은 것으로 본다.
  }
  return null;
}

/** 일반 파일이고 실행 가능한가 — 디렉터리나 실행 비트 없는 파일을 클라이언트로 오인하지 않는다. */
export async function isExecutableFile(p: string): Promise<boolean> {
  try {
    if (!(await stat(p)).isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
