import { ForbiddenException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { loadEnv } from '../config/env';

@Injectable()
export class StorageService {
  private readonly root: string;
  constructor() {
    const root = path.resolve(loadEnv().STORAGE_ROOT);
    // Canonicalize the root so the traversal guard compares against the real
    // path (e.g. macOS /var → /private/var symlink). Falls back to the resolved
    // path if the directory does not exist yet (created lazily on first save).
    this.root = fs.existsSync(root) ? fs.realpathSync(root) : root;
  }

  sanitizeExt(filename: string): string {
    const ext = path.extname(filename).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return ext ? `.${ext}` : '';
  }
  meetingKey(meetingId: string, filename: string): string {
    return `meetings/${meetingId}/original${this.sanitizeExt(filename)}`;
  }
  speakerKey(speakerId: string, filename: string): string {
    return `speakers/${speakerId}/sample${this.sanitizeExt(filename)}`;
  }

  resolve(key: string): string {
    const full = path.resolve(this.root, key);
    const rel = path.relative(this.root, full);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ForbiddenException('invalid storage key');
    }
    return full;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, data);
  }
  async saveFromTemp(key: string, tempPath: string): Promise<void> {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    try {
      await fs.promises.rename(tempPath, full);
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        // temp dir on a different filesystem (e.g. os.tmpdir() vs STORAGE_ROOT)
        await fs.promises.copyFile(tempPath, full);
        await fs.promises.unlink(tempPath);
      } else {
        throw e;
      }
    }
  }
  stat(key: string): Promise<fs.Stats> {
    return fs.promises.stat(this.resolve(key));
  }
  createReadStream(key: string, opts?: { start: number; end: number }): fs.ReadStream {
    return fs.createReadStream(this.resolve(key), opts);
  }
}
