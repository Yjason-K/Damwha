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

  // 확정 경계 append가 누적인지 — StorageService.save()는 writeFile(=truncate)이라
  // 그걸 썼다면 매 청크가 앞 청크를 덮어쓴다. 그 오용이 불가능한지가 이 파일의 출발점이다.
  it('successive writeAt calls accumulate instead of truncating', async () => {
    await svc.create(KEY);
    expect(await svc.writeAt(KEY, 0, Buffer.alloc(32768, 1))).toBe(32768);
    expect(await svc.writeAt(KEY, 32768, Buffer.alloc(32768, 2))).toBe(65536);
    expect(await svc.pcmSize(KEY)).toBe(65536);
    const body = fs.readFileSync(path.join(root, KEY)).subarray(HEADER_LEN);
    expect(body[0]).toBe(1);
    expect(body[32768]).toBe(2);
  });

  it('seal writes the real sizes into the header', async () => {
    await svc.create(KEY);
    await svc.writeAt(KEY, 0, Buffer.alloc(1024, 7));
    await svc.seal(KEY, 1024);
    expect(head().readUInt32LE(40)).toBe(1024);
    expect(head().readUInt32LE(4)).toBe(36 + 1024);
  });

  describe('writeAt / recover (확정 경계 복구, 설계 §3.2–3.3)', () => {
    it('replays a partially written tail from the committed boundary', async () => {
      await svc.create(KEY);
      const first = Buffer.alloc(32768, 1);
      await svc.writeAt(KEY, 0, first);
      fs.appendFileSync(path.join(root, KEY), Buffer.alloc(401, 9));
      await svc.recover(KEY, 32768);
      const tail = Buffer.alloc(1000, 2);
      expect(await svc.writeAt(KEY, 32768, tail)).toBe(33768);
      expect(fs.readFileSync(path.join(root, KEY)).subarray(44)).toEqual(
        Buffer.concat([first, tail]),
      );
    });

    it('recover is a no-op when the file already ends exactly at the committed boundary', async () => {
      await svc.create(KEY);
      await svc.writeAt(KEY, 0, Buffer.alloc(1024, 3));
      await expect(svc.recover(KEY, 1024)).resolves.toBeUndefined();
      expect(await svc.pcmSize(KEY)).toBe(1024);
    });

    it('recover throws when the file is shorter than the committed boundary (lost committed bytes)', async () => {
      await svc.create(KEY);
      await svc.writeAt(KEY, 0, Buffer.alloc(32766, 1)); // 확정=32768이라 주장하지만 실제=32766
      await expect(svc.recover(KEY, 32768)).rejects.toThrow(/32766.*32768|32768.*32766/);
      // 잃은 확정 바이트를 0으로 채워 넣지 않는다 — 파일 길이는 그대로다.
      expect(await svc.pcmSize(KEY)).toBe(32766);
    });

    it('writeAt drains a write() that only advances 7 bytes per call', async () => {
      await svc.create(KEY);
      // fs 전체를 mock하지 않는다: 실제 파일에 정말 7바이트씩 쓰고 실제 bytesWritten을
      // 반환한다. 한 번의 write 호출에 버퍼 전체가 쓰인다고 가정하는 구현은 이 테스트에서
      // 데이터가 잘리거나 write 호출 수가 1로 관찰돼 실패한다.
      const realOpen = fs.promises.open.bind(fs.promises);
      const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const fh = await realOpen(...args);
        const realWrite = fh.write.bind(fh);
        (fh as any).write = async (buffer: Buffer, offset: number, length: number, position: number) => {
          const chunk = Math.min(7, length);
          return realWrite(buffer, offset, chunk, position);
        };
        return fh;
      });
      try {
        const pcm = Buffer.alloc(30, 5);
        expect(await svc.writeAt(KEY, 0, pcm)).toBe(30);
        expect(fs.readFileSync(path.join(root, KEY)).subarray(44)).toEqual(pcm);
      } finally {
        spy.mockRestore();
      }
    });

    it('writeAt throws when write() reports zero bytes written', async () => {
      await svc.create(KEY);
      const realOpen = fs.promises.open.bind(fs.promises);
      const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const fh = await realOpen(...args);
        (fh as any).write = async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
        return fh;
      });
      try {
        await expect(svc.writeAt(KEY, 0, Buffer.alloc(10, 1))).rejects.toThrow(/zero-byte/);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
