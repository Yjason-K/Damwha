import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  CAPABILITIES,
  Capabilities,
  WORKER_CAPABILITIES_KEY,
  WorkerCapabilitiesSchema,
  fromWorkerReport,
} from './capabilities';

/** 워커 보고를 다시 읽기까지의 간격 — 워커 재시작이 새로고침 한 번 안에 반영된다. */
const TTL_MS = 30_000;

/**
 * 머신 스펙의 단일 진입점: **워커가 보고한 실측값 우선, 없으면 API 자신의 추정**.
 *
 * `CAPABILITIES`(부팅 시 1회 감지)의 `gpu_eligible`은 platform+arch **추측**이라
 * Rosetta python으로 깔린 워커를 못 걸러낸다 — env의 `arm64`를 그대로 통과해 UI가 GPU
 * 프리셋을 열어주고, 업로드가 처리 도중 `gpu_unavailable`로 죽는다. 워커는 자기
 * 프로세스에서 MPS를 실제로 재보므로 보고가 있으면 그쪽이 진실이다.
 *
 * 보고가 없거나(워커 미기동/구버전) DB를 못 읽으면 추정으로 조용히 폴백한다 — 이
 * 경로는 업로드가 통과하므로 여기서 예외를 던지면 워커가 잠깐 죽은 동안 업로드가 전부
 * 막힌다.
 */
@Injectable()
export class CapabilitiesService {
  private readonly logger = new Logger(CapabilitiesService.name);
  private cached: { at: number; value: Capabilities } | null = null;

  constructor(
    private readonly db: DatabaseService,
    @Inject(CAPABILITIES) private readonly base: Capabilities,
  ) {}

  async get(): Promise<Capabilities> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < TTL_MS) return this.cached.value;
    const value = (await this.readWorkerReport()) ?? this.base;
    this.cached = { at: now, value };
    return value;
  }

  private async readWorkerReport(): Promise<Capabilities | null> {
    try {
      const r = await this.db.pool.query('SELECT value FROM app_setting WHERE key=$1', [
        WORKER_CAPABILITIES_KEY,
      ]);
      if (!r.rows[0]) return null;
      const parsed = WorkerCapabilitiesSchema.safeParse(r.rows[0].value);
      if (!parsed.success) {
        this.logger.warn(`worker capabilities row is malformed — ignoring: ${parsed.error.message}`);
        return null;
      }
      return fromWorkerReport(parsed.data);
    } catch (e) {
      this.logger.warn(
        `could not read worker capabilities: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }
}
