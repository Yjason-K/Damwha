import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../settings/settings.service';
import { ModelReadinessService } from '../system/model-readiness.service';
import { MODEL_INVENTORY_KEY, ModelInventory, fromInventoryRow } from './model-inventory';
import { ModelsView, buildModelsView } from './models-view';

/**
 * `GET /models`의 읽기 (모델 다운로드 관리 스펙 §5.1). `app_setting.model_inventory`·
 * `model_readiness`·처리 설정을 **읽기만** 한다 — 이 모듈에 app_setting 쓰기가 생기면 worker
 * 단일 writer 계약이 깨진다.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly readiness: ModelReadinessService,
  ) {}

  async list(): Promise<ModelsView> {
    const env = loadEnv();
    const [config, readiness, inventory] = await Promise.all([
      this.settings.getProcessingConfig(),
      this.readiness.get(),
      this.readInventory(),
    ]);
    return buildModelsView({
      config,
      fixed: {
        diarization: env.DIARIZATION_MODEL,
        speaker_embedding: env.EMBEDDING_MODEL,
        search_embedding: env.SEARCH_EMBEDDING_MODEL,
      },
      lensModel: env.LENS_LLM_MODEL,
      inventory,
      readiness,
      now: Date.now(),
    });
  }

  /** 못 읽으면 null("아직 스캔 안 됨") — `ModelReadinessService`와 같은 조용한 폴백. */
  private async readInventory(): Promise<ModelInventory | null> {
    try {
      const r = await this.db.pool.query('SELECT value FROM app_setting WHERE key=$1', [MODEL_INVENTORY_KEY]);
      return r.rows[0] ? fromInventoryRow(r.rows[0].value) : null;
    } catch (e) {
      this.logger.warn(`could not read model inventory: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}
