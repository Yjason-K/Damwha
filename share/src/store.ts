import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHARE_ID_RE } from '@damwha/share-format';

export interface ShareMeta {
  expires_at: string;
  /** 삭제 토큰의 SHA-256(hex). 원문은 저장하지 않는다. */
  token_hash: string;
  size: number;
  created_at: string;
}

const ORPHAN_AGE_MS = 3_600_000;
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * 공유본 하나 = `shares/<id>.bin`(봉투) + `shares/<id>.json`(메타). **메타가 있어야 존재한다** — 봉투를 먼저 쓰고
 * 메타를 나중에 쓰며(둘 다 임시 파일 → rename), 지울 때는 메타를 먼저 지운다. 그래서 쓰다 죽거나 지우다 죽어도
 * 읽기 경로에 반쯤 된 공유가 보이지 않는다. 파일 이름은 SHARE_ID_RE를 통과한 id만 쓴다(경로 탈출 차단).
 */
export class DiskStore {
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'shares');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(id: string, ext: 'bin' | 'json'): string {
    if (!SHARE_ID_RE.test(id)) throw new Error('invalid share id');
    return join(this.dir, `${id}.${ext}`);
  }

  async put(id: string, body: Uint8Array, meta: ShareMeta): Promise<void> {
    const bin = this.path(id, 'bin');
    const json = this.path(id, 'json');
    await writeFile(`${bin}.tmp`, body);
    await rename(`${bin}.tmp`, bin);
    await writeFile(`${json}.tmp`, JSON.stringify(meta));
    await rename(`${json}.tmp`, json);
  }

  /**
   * 메타를 읽는다. 해석할 수 없는 메타(빈·잘린 JSON, 만료 시각·토큰 해시를 못 읽음)는 그 쌍을 지우고 'corrupt' —
   * 메타는 임시 파일 → rename으로만 생기므로 쓰는 중인 메타가 이렇게 보이는 일은 없다(이슈 #106).
   */
  private async readMeta(id: string): Promise<ShareMeta | null | 'corrupt'> {
    let text: string;
    try {
      text = await readFile(this.path(id, 'json'), 'utf8');
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    const meta = parseMeta(text);
    if (meta) return meta;
    await this.removePair(id);
    return 'corrupt';
  }

  async head(id: string): Promise<ShareMeta | null> {
    const meta = await this.readMeta(id);
    return meta === 'corrupt' ? null : meta;
  }

  async get(id: string): Promise<{ body: Uint8Array<ArrayBuffer>; meta: ShareMeta } | null> {
    const meta = await this.head(id);
    if (!meta) return null;
    try {
      return { body: new Uint8Array(await readFile(this.path(id, 'bin'))), meta };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async delete(id: string): Promise<boolean> {
    const existed = (await this.head(id)) !== null;
    await this.removePair(id);
    return existed;
  }

  private async removePair(id: string): Promise<void> {
    await rm(this.path(id, 'json'), { force: true });
    await rm(this.path(id, 'bin'), { force: true });
  }

  /**
   * 만료된 공유와 해석할 수 없는 메타의 쌍을 지우고, 메타 없는 봉투·임시 파일은 1시간이 지난 것만 지운다(쓰는 중일
   * 수 있다). 한 항목의 오류가 나머지 청소를 막지 않는다 — 끝까지 돈 뒤 첫 오류로 reject한다.
   */
  async sweep(now: Date): Promise<number> {
    let removed = 0;
    let failure: unknown = null;
    for (const name of await readdir(this.dir)) {
      try {
        if (await this.sweepEntry(name, now)) removed++;
      } catch (e) {
        failure ??= e;
      }
    }
    if (failure !== null) throw failure;
    return removed;
  }

  private async sweepEntry(name: string, now: Date): Promise<boolean> {
    const full = join(this.dir, name);
    if (name.endsWith('.json')) {
      const id = name.slice(0, -'.json'.length);
      if (!SHARE_ID_RE.test(id)) return false;
      const meta = await this.readMeta(id);
      if (meta === 'corrupt') return true;
      if (meta && Date.parse(meta.expires_at) <= now.getTime()) {
        await this.delete(id);
        return true;
      }
      return false;
    }
    const isTmp = name.endsWith('.tmp');
    const binId = name.endsWith('.bin') ? name.slice(0, -'.bin'.length) : null;
    let orphan = isTmp;
    if (binId !== null && SHARE_ID_RE.test(binId)) {
      const meta = await this.readMeta(binId);
      if (meta === 'corrupt') return true;
      orphan = meta === null;
    }
    if (!orphan) return false;
    // 이 목록을 만든 뒤 같은 쌍의 다른 파일을 지우면서 이 파일도 사라졌을 수 있다 — 이미 된 일이다.
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(full)).mtimeMs;
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
    if (now.getTime() - mtimeMs <= ORPHAN_AGE_MS) return false;
    await rm(full, { force: true });
    return true;
  }
}

/** 읽기·청소가 기대는 필드만 확인한다 — 만료 시각을 못 읽는 메타가 영원히 서빙되지 않게(NaN은 비교가 늘 거짓). */
function parseMeta(text: string): ShareMeta | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Partial<ShareMeta>;
  if (typeof m.expires_at !== 'string' || !Number.isFinite(Date.parse(m.expires_at))) return null;
  if (typeof m.token_hash !== 'string') return null;
  return m as ShareMeta;
}
