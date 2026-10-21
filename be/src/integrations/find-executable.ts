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

/** claude·codex를 먼저 찾아보는 설치 위치. 실행할 때 자식 PATH에도 같은 목록을 넣는다 (run-command.ts). */
export const searchDirs = (home: string) => [`${home}/.local/bin`, `${home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin'];

/**
 * 앱이 Finder에서 떠서 API 프로세스 PATH에 사용자 셸 PATH가 없을 수 있다. 알려진 설치 위치를 먼저 보고, 없으면
 * 사용자 로그인 셸이 zsh·bash일 때만 `command -v`로 묻는다 (spec §2.7). 어느 쪽이든 절대 경로의 실행 파일만 돌려준다.
 */
export async function findExecutable(name: 'claude' | 'codex', deps: FindDeps): Promise<string | null> {
  for (const dir of searchDirs(deps.home)) {
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

/**
 * 사용자 로그인 셸의 PATH. Finder에서 뜬 앱의 API는 PATH가 /usr/bin:/bin:/usr/sbin:/sbin뿐이라 "~/.local/bin이
 * PATH에 있는가"를 자기 PATH로 답하면 늘 틀린다. findExecutable과 같은 탐침(zsh·bash만, 고정 인자)을 쓰고,
 * 못 얻으면 null — 호출부가 프로세스 PATH로 물러난다.
 */
export async function loginShellPath(deps: Pick<FindDeps, 'shell' | 'run'>): Promise<string | null> {
  if (!deps.shell || !SHELLS.has(deps.shell)) return null;
  try {
    const r = await deps.run(deps.shell, ['-lc', 'printf %s "$PATH"']);
    if (r.code !== 0) return null;
    // printf는 줄바꿈을 붙이지 않는다. 앞에 rc 잡음이 있으면 마지막 줄이 PATH다.
    const line = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    return line || null;
  } catch {
    return null;
  }
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
