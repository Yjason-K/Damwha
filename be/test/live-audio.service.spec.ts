import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveAudioService, HEADER_LEN, STREAMING_SIZE } from '../src/storage/live-audio.service';
import { StorageService } from '../src/storage/storage.service';

describe('LiveAudioService', () => {
  let root: string; let storage: StorageService; let svc: LiveAudioService;
  const KEY = 'meetings/mtg_1/live.wav';

  beforeEach(() => {
    // loadEnv() parses the full env schema; DATABASE_URL is required.
    // This standalone unit test has no DB harness, so provide a dummy.
    process.env.DATABASE_URL ??= 'postgres://localhost/test';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damwha-live-'));
    process.env.STORAGE_ROOT = root;
    storage = new StorageService();
    svc = new LiveAudioService(storage);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const head = () => fs.readFileSync(path.join(root, KEY)).subarray(0, HEADER_LEN);

  it('create writes a 44-byte streaming header', async () => {
    await svc.create(KEY);
    const h = head();
    expect(h.length).toBe(HEADER_LEN);
    expect(h.subarray(0, 4).toString()).toBe('RIFF');
    expect(h.subarray(8, 12).toString()).toBe('WAVE');
    expect(h.subarray(36, 40).toString()).toBe('data');
    expect(h.readUInt32LE(4)).toBe(STREAMING_SIZE);
    expect(h.readUInt32LE(40)).toBe(STREAMING_SIZE);
    expect(h.readUInt32LE(24)).toBe(16000); // sample rate
  });

  it('pcmSize is -1 before create and 0 after', async () => {
    expect(await svc.pcmSize(KEY)).toBe(-1);
    await svc.create(KEY);
    expect(await svc.pcmSize(KEY)).toBe(0);
  });

  it('append accumulates instead of truncating', async () => {
    await svc.create(KEY);
    expect(await svc.append(KEY, Buffer.alloc(32768, 1))).toBe(32768);
    expect(await svc.append(KEY, Buffer.alloc(32768, 2))).toBe(65536);
    expect(await svc.pcmSize(KEY)).toBe(65536);
    const body = fs.readFileSync(path.join(root, KEY)).subarray(HEADER_LEN);
    expect(body[0]).toBe(1);
    expect(body[32768]).toBe(2);
  });

  it('seal writes the real sizes into the header', async () => {
    await svc.create(KEY);
    await svc.append(KEY, Buffer.alloc(1024, 7));
    await svc.seal(KEY, 1024);
    expect(head().readUInt32LE(40)).toBe(1024);
    expect(head().readUInt32LE(4)).toBe(36 + 1024);
  });
});
