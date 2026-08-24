import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsRepository, PROCESSING_KEY } from './settings.repository';
import { ProcessingConfig } from './presets';
import {
  StoredProcessingValue, StoredProcessingValueSchema,
  envFallbackProcessingConfig, resolveStoredValue,
} from './processing-config';

@Injectable()
export class SettingsService {
  private readonly log = new Logger(SettingsService.name);
  constructor(private readonly db: DatabaseService, private readonly repo: SettingsRepository) {}

  // GET과 enqueue가 공유하는 단일 로더 — 폴백 정책 동일 (spec §1)
  async getProcessingConfig(): Promise<ProcessingConfig> {
    const raw = await this.repo.getValue(this.db.pool, PROCESSING_KEY);
    if (raw === null) return envFallbackProcessingConfig();
    const parsed = StoredProcessingValueSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn(`corrupt processing_defaults value — falling back to env: ${parsed.error.message}`);
      return envFallbackProcessingConfig();
    }
    return resolveStoredValue(parsed.data);
  }

  async putProcessing(value: StoredProcessingValue): Promise<ProcessingConfig> {
    await this.repo.putValue(this.db.pool, PROCESSING_KEY, value);
    return resolveStoredValue(value);
  }
}
