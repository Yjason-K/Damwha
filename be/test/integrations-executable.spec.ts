import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isExecutableFile } from '../src/integrations/find-executable';

describe('isExecutableFile', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damwha-exec-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('실행 비트가 있는 일반 파일만 true', async () => {
    const f = path.join(dir, 'bin');
    fs.writeFileSync(f, '#!/bin/sh\n');
    fs.chmodSync(f, 0o644);
    expect(await isExecutableFile(f)).toBe(false);
    fs.chmodSync(f, 0o755);
    expect(await isExecutableFile(f)).toBe(true);
  });

  it('디렉터리와 없는 경로는 false', async () => {
    expect(await isExecutableFile(dir)).toBe(false);
    expect(await isExecutableFile(path.join(dir, 'nope'))).toBe(false);
  });
});
