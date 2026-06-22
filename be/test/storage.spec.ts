import { StorageService } from '../src/storage/storage.service';
import { ForbiddenException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('StorageService', () => {
  let root: string;
  let svc: StorageService;

  beforeEach(() => {
    // loadEnv() parses the full env schema; DATABASE_URL is required.
    // This standalone unit test has no DB harness, so provide a dummy.
    process.env.DATABASE_URL ??= 'postgres://localhost/test';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-store-'));
    process.env.STORAGE_ROOT = root;
    svc = new StorageService();
  });

  it('builds UUID-based keys, ignoring untrusted filename', () => {
    expect(svc.meetingKey('11111111-1111-1111-1111-111111111111', '../../evil.MP3'))
      .toBe('meetings/11111111-1111-1111-1111-111111111111/original.mp3');
    expect(svc.speakerKey('22222222-2222-2222-2222-222222222222', 'no-ext'))
      .toBe('speakers/22222222-2222-2222-2222-222222222222/sample');
  });

  it('saves and resolves within root', async () => {
    const key = svc.meetingKey('aaaa', 'a.wav');
    await svc.save(key, Buffer.from('hello'));
    const full = svc.resolve(key);
    expect(full.startsWith(fs.realpathSync(root))).toBe(true);
    expect(fs.readFileSync(full, 'utf8')).toBe('hello');
  });

  it('rejects path traversal and absolute keys', () => {
    expect(() => svc.resolve('../../etc/passwd')).toThrow(ForbiddenException);
    expect(() => svc.resolve('/etc/passwd')).toThrow(ForbiddenException);
    expect(() => svc.resolve('meetings/../../secret')).toThrow(ForbiddenException);
  });

  it('streams a byte range', async () => {
    const key = svc.meetingKey('bbbb', 'a.wav');
    await svc.save(key, Buffer.from('0123456789'));
    const chunks: Buffer[] = [];
    await new Promise<void>((res, rej) => {
      svc.createReadStream(key, { start: 2, end: 5 })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('end', res).on('error', rej);
    });
    expect(Buffer.concat(chunks).toString()).toBe('2345');
  });

  it('saveFromTemp moves a temp file into the keyed location', async () => {
    const tmp = path.join(os.tmpdir(), 'dw-tmp-src');
    fs.writeFileSync(tmp, 'tempdata');
    const key = svc.meetingKey('cccc', 'a.wav');
    await svc.saveFromTemp(key, tmp);
    expect(fs.readFileSync(svc.resolve(key), 'utf8')).toBe('tempdata');
    expect(fs.existsSync(tmp)).toBe(false); // temp consumed
  });
});
