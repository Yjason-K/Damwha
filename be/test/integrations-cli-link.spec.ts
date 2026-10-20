import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLink, installLink, isDamwhaLauncherPath, removeLink } from '../src/integrations/cli-link';
import { ConflictError } from '../src/integrations/errors';

const LAUNCHER = '/Applications/Damwha.app/Contents/Resources/cli/damwha';
const OTHER = '/Old.app/Contents/Resources/cli/damwha';

describe('cli-link', () => {
  let dir: string;
  let link: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'damwha-link-'));
    link = join(dir, '.local', 'bin', 'damwha');
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));
  const mk = async (target: string) => {
    await fs.mkdir(join(dir, '.local', 'bin'), { recursive: true });
    await fs.symlink(target, link);
  };

  it('isDamwhaLauncherPath recognizes bundle and dev build only', () => {
    expect(isDamwhaLauncherPath(LAUNCHER)).toBe(true);
    expect(isDamwhaLauncherPath('/repo/desktop/build/cli/damwha')).toBe(true);
    expect(isDamwhaLauncherPath('/usr/local/bin/damwha')).toBe(false);
    expect(isDamwhaLauncherPath('/x/Contents/Resources/cli/other')).toBe(false);
  });

  it('absent when missing', async () => {
    expect(await inspectLink(link, LAUNCHER, fs)).toEqual({ kind: 'absent' });
  });

  it('current when points to launcher', async () => {
    await mk(LAUNCHER);
    expect(await inspectLink(link, LAUNCHER, fs)).toEqual({ kind: 'current' });
  });

  it('other_damwha when points to another bundle', async () => {
    await mk(OTHER);
    expect(await inspectLink(link, LAUNCHER, fs)).toEqual({ kind: 'other_damwha', target: OTHER });
  });

  it('replaces dangling damwha link', async () => {
    await mk(OTHER);
    expect(await installLink(link, LAUNCHER, fs)).toEqual({ kind: 'current' });
    expect(await fs.readlink(link)).toBe(LAUNCHER);
    expect(await fs.readdir(join(dir, '.local', 'bin'))).toEqual(['damwha']);
  });

  it('foreign regular file is 409', async () => {
    await fs.mkdir(join(dir, '.local', 'bin'), { recursive: true });
    await fs.writeFile(link, '#!/bin/sh\n');
    expect(await inspectLink(link, LAUNCHER, fs)).toEqual({ kind: 'foreign', target: link, isFile: true });
    await expect(installLink(link, LAUNCHER, fs)).rejects.toBeInstanceOf(ConflictError);
    expect(await fs.readFile(link, 'utf8')).toBe('#!/bin/sh\n');
  });

  it('foreign link is 409', async () => {
    await mk('/usr/local/bin/damwha');
    await expect(installLink(link, LAUNCHER, fs)).rejects.toMatchObject({ target: '/usr/local/bin/damwha' });
    expect(await fs.readlink(link)).toBe('/usr/local/bin/damwha');
  });

  it('creates ~/.local/bin when missing', async () => {
    expect(await installLink(link, LAUNCHER, fs)).toEqual({ kind: 'current' });
    expect(await fs.readlink(link)).toBe(LAUNCHER);
  });

  it('remove deletes damwha link, leaves foreign link alone', async () => {
    await mk(OTHER);
    await removeLink(link, LAUNCHER, fs);
    expect(await inspectLink(link, LAUNCHER, fs)).toEqual({ kind: 'absent' });

    await fs.symlink('/usr/local/bin/damwha', link);
    await removeLink(link, LAUNCHER, fs);
    expect(await fs.readlink(link)).toBe('/usr/local/bin/damwha');
  });
});
