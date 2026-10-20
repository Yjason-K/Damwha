import { dirname, basename, resolve } from 'node:path';
import type * as fsp from 'node:fs/promises';
import { ConflictError } from './errors';

export type LinkFs = Pick<typeof fsp, 'lstat' | 'readlink' | 'symlink' | 'unlink' | 'mkdir' | 'rename'>;

export type LinkState =
  | { kind: 'absent' }
  | { kind: 'current' }
  | { kind: 'other_damwha'; target: string }
  | { kind: 'foreign'; target: string; isFile: boolean };

/** 패키징된 앱 번들 또는 개발 빌드의 런처인가. 번들이 지워져 대상이 없어도 경로만으로 담화 것임을 안다. */
export function isDamwhaLauncherPath(target: string): boolean {
  return (
    basename(target) === 'damwha' &&
    (target.endsWith('/Contents/Resources/cli/damwha') || target.endsWith('/desktop/build/cli/damwha'))
  );
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export async function inspectLink(linkPath: string, launcher: string, fs: LinkFs): Promise<LinkState> {
  let stat;
  try {
    stat = await fs.lstat(linkPath);
  } catch (e) {
    if (isNotFound(e)) return { kind: 'absent' };
    throw e;
  }
  // 일반 파일·디렉터리는 남의 것 — 절대 덮어쓰지 않는다.
  if (!stat.isSymbolicLink()) return { kind: 'foreign', target: linkPath, isFile: true };

  const raw = await fs.readlink(linkPath);
  const target = resolve(dirname(linkPath), raw);
  if (target === launcher) return { kind: 'current' };
  if (isDamwhaLauncherPath(target)) return { kind: 'other_damwha', target };
  return { kind: 'foreign', target, isFile: false };
}

/** 없거나 다른 번들의 담화 링크면 launcher를 가리키게 한다. 남의 것이면 ConflictError. */
export async function installLink(linkPath: string, launcher: string, fs: LinkFs): Promise<LinkState> {
  const state = await inspectLink(linkPath, launcher, fs);
  if (state.kind === 'current') return state;
  if (state.kind === 'foreign') throw new ConflictError(state.target);

  await fs.mkdir(dirname(linkPath), { recursive: true });
  // 임시 링크를 만들어 rename으로 덮는다 — unlink 후 symlink 사이에 링크가 없는 순간이 생기지 않는다.
  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.symlink(launcher, tmp);
  try {
    await fs.rename(tmp, linkPath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  return { kind: 'current' };
}

/** 담화 링크일 때만 지운다. 남의 파일·링크나 없는 경로는 그대로 둔다. */
export async function removeLink(linkPath: string, launcher: string, fs: LinkFs): Promise<void> {
  const state = await inspectLink(linkPath, launcher, fs);
  if (state.kind === 'current' || state.kind === 'other_damwha') await fs.unlink(linkPath);
}
