/**
 * 크래시 회귀용 자식 API 프로세스.
 *
 * 부모(jest)가 준 DATABASE_URL/STORAGE_ROOT로 테스트 Nest 앱을 띄우고, IPC로 받은 요청
 * 하나를 자기 자신의 HTTP 서버에 보낸다. CRASH_POINT가 지정돼 있으면 그 지점에서
 * `{type:'barrier', point}`를 부모에게 보낸 뒤 **영원히 멈춘다** — 부모가 그 자리에서
 * SIGKILL한다. 프로세스가 통째로 사라지므로 finally도, 롤백도, 응답도 없다.
 *
 * 주입 지점을 운영 코드가 아니라 이 파일에만 두는 것이 요점이다. 프로덕션 HTTP fault
 * injection 엔드포인트를 만들면 그것 자체가 배포되는 공격면이 된다 (설계 §2.2).
 */
import 'reflect-metadata';
import * as fs from 'fs';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CAPABILITIES } from '../../src/system/capabilities';
import { HEADER_LEN, LiveAudioService } from '../../src/storage/live-audio.service';
import { StorageService } from '../../src/storage/storage.service';
import { CHUNK_BYTES, LiveService } from '../../src/live/live.service';

/** 설계 §3.4 크래시 표의 세 줄. `none`은 크래시 없이 같은 요청을 재생하는 재기동 자식이다. */
export type CrashPoint = 'partial_write' | 'after_sync' | 'after_commit' | 'none';

export type ChildCommand =
  | { type: 'append'; id: string; offset: number; fill: number }
  | { type: 'stop'; id: string; offset: number; final: number; fill: number; length: number };

export type ChildMessage =
  | { type: 'ready' }
  | { type: 'barrier'; point: CrashPoint }
  | { type: 'result'; status: number; body: unknown };

/** 부분 쓰기가 남기는 미확정 꼬리. 홀수라 프레임 경계조차 맞지 않는다 — 정본으로
 *  인정되면 곧바로 드러난다. */
const PARTIAL_BYTES = 401;

const send = (m: ChildMessage) => process.send?.(m);

/** 부모에게 지점을 알리고 영원히 멈춘다. 이 프로세스를 끝내는 것은 SIGKILL뿐이다. */
function barrier(point: CrashPoint): Promise<never> {
  send({ type: 'barrier', point });
  return new Promise<never>(() => undefined);
}

function injectCrash(app: INestApplication, point: CrashPoint): void {
  const audio = app.get(LiveAudioService);
  const storage = app.get(StorageService);
  const live = app.get(LiveService);

  if (point === 'partial_write') {
    // ① PCM 일부 쓰기 중. 확정 경계 뒤에 401바이트만 닿은 채로 죽는다.
    audio.writeAt = async (key: string, offset: number, pcm: Buffer): Promise<number> => {
      const fh = await fs.promises.open(storage.resolve(key), 'r+');
      try {
        await fh.write(pcm, 0, PARTIAL_BYTES, HEADER_LEN + offset);
        await fh.datasync();
      } finally {
        await fh.close();
      }
      return barrier(point);
    };
    return;
  }
  if (point === 'after_sync') {
    // ② PCM sync 후 commit 전. 디스크엔 전부 있지만 DB는 아직 이전 경계다.
    const real = audio.writeAt.bind(audio);
    audio.writeAt = async (key: string, offset: number, pcm: Buffer): Promise<number> => {
      await real(key, offset, pcm);
      return barrier(point);
    };
    return;
  }
  if (point === 'after_commit') {
    // ③ commit 후 응답 전. 경계는 이미 전진했고 클라이언트만 ACK를 잃는다.
    const append = live.appendAudio.bind(live);
    const stop = live.stop.bind(live);
    live.appendAudio = async (...args: Parameters<LiveService['appendAudio']>) => {
      await append(...args);
      return barrier(point);
    };
    live.stop = async (...args: Parameters<LiveService['stop']>) => {
      await stop(...args);
      return barrier(point);
    };
  }
}

async function run(app: INestApplication, cmd: ChildCommand): Promise<void> {
  const srv = app.getHttpServer();
  const res =
    cmd.type === 'append'
      ? await request(srv)
        .post(`/meetings/${cmd.id}/live/audio`)
        .set('Content-Type', 'application/octet-stream')
        .set('X-Audio-Offset', String(cmd.offset))
        .send(Buffer.alloc(CHUNK_BYTES, cmd.fill))
      : await request(srv)
        .post(`/meetings/${cmd.id}/live/stop`)
        .set('Content-Type', 'application/octet-stream')
        .set('X-Audio-Offset', String(cmd.offset))
        .set('X-Final-Offset', String(cmd.final))
        .send(Buffer.alloc(cmd.length, cmd.fill));
  send({ type: 'result', status: res.status, body: res.body });
}

async function main(): Promise<void> {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CAPABILITIES)
    .useValue({
      platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32,
      gpu_eligible: true, recommended_preset: 'standard',
    })
    .compile();
  const app = mod.createNestApplication();
  await app.init();
  // 이 자식도 AppModule 전체를 띄우므로 LiveOrphanService.sweepScheduled가 30초마다 돈다.
  // 부모와 같은 DB·파일을 공유하는 채로 크래시 지점에서 영원히 멈춰 있는 자식이므로,
  // 배경 스윕이 그 사이 끼어들어 job/meeting을 건드리면 부모 쪽 어서션이 흔들린다.
  app.get(SchedulerRegistry).getCronJobs().forEach((job) => job.stop());

  injectCrash(app, (process.env.CRASH_POINT ?? 'none') as CrashPoint);
  process.on('message', (cmd: ChildCommand) => {
    void run(app, cmd);
  });
  send({ type: 'ready' });
}

main().catch((e: unknown) => {
  process.stderr.write(`live-crash-child failed to start: ${String(e)}\n`);
  process.exit(1);
});
