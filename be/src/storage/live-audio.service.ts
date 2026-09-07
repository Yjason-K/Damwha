import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { StorageService } from './storage.service';

export const SR = 16000;
export const CHANNELS = 1;
export const SAMPLE_WIDTH = 2;
export const HEADER_LEN = 44;
/** ffmpeg가 seek 불가 출력에 쓰는 "길이 미정" 관례. 0이나 실제보다 작은 값과 달리
 *  ffmpeg가 EOF까지 읽는다 — 어느 순간 죽어도 디스크에 닿은 프레임까지 살아 있다. */
export const STREAMING_SIZE = 0xffffffff;

function header(dataSize: number, riffSize: number): Buffer {
  const b = Buffer.alloc(HEADER_LEN);
  b.write('RIFF', 0); b.writeUInt32LE(riffSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(CHANNELS, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * CHANNELS * SAMPLE_WIDTH, 28);
  b.writeUInt16LE(CHANNELS * SAMPLE_WIDTH, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataSize, 40);
  return b;
}

/**
 * 라이브 녹음 WAV의 파일 연산. StorageService.save()가 writeFile(=truncate)이라
 * append 경로에서 쓰면 매 청크가 앞 청크를 덮어쓴다. 그 오용이 불가능하도록 분리했다.
 *
 * 모든 쓰기는 fdatasync 뒤에 반환한다. API가 200을 돌려준 오디오는 전원 장애에도
 * 남아야 한다 — 원 설계가 fsync를 뺀 근거("프로세스 crash에서는 page cache가 산다")는
 * API가 writer가 되면서 생긴 사용자 약속을 덮지 못한다 (설계 §2.8).
 */
@Injectable()
export class LiveAudioService {
  constructor(private readonly storage: StorageService) {}

  /** 헤더만 있는 파일을 만든다. temp write → fsync → rename → 디렉터리 sync. */
  async create(key: string): Promise<void> {
    const full = this.storage.resolve(key);
    const dir = path.dirname(full);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${full}.tmp`;
    const fh = await fs.promises.open(tmp, 'w');
    try {
      try {
        await fh.write(header(STREAMING_SIZE, STREAMING_SIZE));
        await fh.datasync();
      } finally { await fh.close(); }
    } catch (e) {
      // 설계 §4.1의 실패 매트릭스가 임시 파일 정리를 요구한다. 안 지우면 회의를
      // 지울 때까지 남는다 — 그 자체가 디스크 부족의 원인이었을 수도 있다.
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw e;
    }
    await fs.promises.rename(tmp, full);
    const dh = await fs.promises.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  }

  /** PCM 바이트 수(헤더 제외). 파일이 없으면 -1 — "0바이트 녹음"과 구별해야 한다. */
  async pcmSize(key: string): Promise<number> {
    const st = await this.storage.statOrNull(key);
    return st === null ? -1 : st.size - HEADER_LEN;
  }

  /** 이어 붙이고 fdatasync한 뒤 새 PCM 크기를 돌려준다. */
  async append(key: string, pcm: Buffer): Promise<number> {
    const fh = await fs.promises.open(this.storage.resolve(key), 'r+');
    try {
      const { size } = await fh.stat();
      await fh.write(pcm, 0, pcm.length, size);
      await fh.datasync();
      return size + pcm.length - HEADER_LEN;
    } finally { await fh.close(); }
  }

  /**
   * committed 경계 뒤 미확정 꼬리를 truncate한다. 파일이 그 경계보다 짧으면 확정된
   * 바이트 자체를 잃었다는 뜻이라 오류를 던진다 — 0으로 메워 넣지 않는다. 같으면
   * no-op이다 (설계 §3.3 ①·②).
   */
  async recover(key: string, committedBytes: number): Promise<void> {
    const boundary = HEADER_LEN + committedBytes;
    const fh = await fs.promises.open(this.storage.resolve(key), 'r+');
    try {
      const { size } = await fh.stat();
      if (size < boundary) {
        throw new Error(`live audio is ${size - HEADER_LEN} PCM bytes but committed ${committedBytes}: ${key}`);
      }
      if (size > boundary) {
        await fh.truncate(boundary);
        await fh.datasync();
      }
    } finally { await fh.close(); }
  }

  /**
   * committed 경계에 완전 positional write를 한다. 한 번의 write 호출이 버퍼 전체를
   * 쓴다고 가정하지 않는다 — bytesWritten만큼만 전진하고 나머지를 반복해서 쓴다.
   * fdatasync 뒤 새 확정 경계(offset+len)를 돌려준다 (설계 §3.2–3.3).
   */
  async writeAt(key: string, offset: number, pcm: Buffer): Promise<number> {
    const fh = await fs.promises.open(this.storage.resolve(key), 'r+');
    try {
      let written = 0;
      while (written < pcm.length) {
        const result = await fh.write(
          pcm,
          written,
          pcm.length - written,
          HEADER_LEN + offset + written,
        );
        if (result.bytesWritten === 0) throw new Error('zero-byte live audio write');
        written += result.bytesWritten;
      }
      await fh.datasync();
      return offset + written;
    } finally { await fh.close(); }
  }

  /** 헤더를 실제 크기로 확정한다. 봉인 커밋 뒤 best-effort로 부른다 (설계 §4.4 ④). */
  async seal(key: string, pcmBytes: number): Promise<void> {
    const fh = await fs.promises.open(this.storage.resolve(key), 'r+');
    try {
      // 설계 §3.3.1이 요구하는 그물. 가드된 append만 파일을 늘리므로 산술상으로는
      // 늘 성립하지만, 그 불변식이 깨진 채 헤더에 sealed_bytes를 써 넣으면 정본이
      // 조용히 길거나 짧아진다 — 워커는 sealed_bytes만 보고 그 길이를 진실로 삼는다.
      // 여기서 던지면 봉인 커밋은 이미 끝난 뒤라 호출자가 best-effort로 삼키고,
      // 재처리 때 repair_streaming_header가 고친다 (설계 §4.4 ④).
      const { size } = await fh.stat();
      if (size - HEADER_LEN !== pcmBytes) {
        throw new Error(`live audio is ${size - HEADER_LEN} PCM bytes but sealed at ${pcmBytes}: ${key}`);
      }
      await fh.write(header(pcmBytes, 36 + pcmBytes), 0, HEADER_LEN, 0);
      await fh.datasync();
    } finally { await fh.close(); }
  }
}
