import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

export const PROCESSING_KEY = 'processing_defaults';

@Injectable()
export class SettingsRepository {
  async getValue(pool: Pool, key: string): Promise<unknown | null> {
    const r = await pool.query('SELECT value FROM app_setting WHERE key=$1', [key]);
    return r.rows[0]?.value ?? null;
  }
  async putValue(pool: Pool, key: string, value: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO app_setting(key, value) VALUES($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
}
