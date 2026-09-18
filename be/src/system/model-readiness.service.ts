import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  EMPTY_MODEL_READINESS,
  MODEL_READINESS_KEY,
  ModelReadiness,
  fromReadinessRow,
} from './model-readiness';

/**
 * `app_setting.model_readiness`를 **읽기만** 한다 (Phase 4 스펙 §6.9). 읽는 방식은
 * `CapabilitiesService.readWorkerReport`와 같은 꼴이다 — 같은 테이블의 같은 단방향 행이고,
 * 같은 이유로 실패가 조용한 폴백이어야 한다.
 *
 * **캐시가 없다.** `CapabilitiesService`는 30초 TTL을 두지만 그쪽이 재는 것은 세션 중 거의 안 바뀌는
 * 머신 스펙이고, 이 행은 진행률이라 초 단위로 바뀐다 — 캐시하면 화면의 진행 막대가 멈춘 것처럼 보인다.
 * 읽는 것은 key 하나의 단건 조회다.
 *
 * 못 읽으면 빈 준비 상태다. 여기서 던지면 워커가 잠깐 죽은 동안 설정 조회 전체가 500이 된다 —
 * 이 값은 설정 응답의 **곁가지**이지 그 응답이 성립하는 조건이 아니다.
 */
@Injectable()
export class ModelReadinessService {
  private readonly logger = new Logger(ModelReadinessService.name);

  constructor(private readonly db: DatabaseService) {}

  async get(): Promise<ModelReadiness> {
    try {
      const r = await this.db.pool.query('SELECT value FROM app_setting WHERE key=$1', [
        MODEL_READINESS_KEY,
      ]);
      if (!r.rows[0]) return EMPTY_MODEL_READINESS;
      return fromReadinessRow(r.rows[0].value);
    } catch (e) {
      this.logger.warn(
        `could not read model readiness: ${e instanceof Error ? e.message : String(e)}`,
      );
      return EMPTY_MODEL_READINESS;
    }
  }
}
