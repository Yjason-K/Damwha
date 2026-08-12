import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { SettingsService } from '../src/settings/settings.service';
import { PRESET_REVISION } from '../src/settings/presets';

describe('SettingsService.getProcessingConfig', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let service: SettingsService;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    service = app.get(SettingsService);
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('행 없음 → env 폴백 (WHISPER_DEVICE=mps → 전 단계 gpu, preset custom, revision null)', async () => {
    const cfg = await service.getProcessingConfig();
    expect(cfg.preset).toBe('custom');
    expect(cfg.preset_revision).toBeNull();
    expect(cfg.devices).toEqual({ diarization: 'gpu', stt: 'gpu' });
    expect(cfg.whisper_model).toBe('large-v3-turbo');
  });

  it('이름 프리셋 저장 → 항상 상수에서 resolve', async () => {
    await service.putProcessing({ preset: 'light', language: 'ko' });
    const cfg = await service.getProcessingConfig();
    expect(cfg).toEqual({
      preset: 'light', preset_revision: PRESET_REVISION, language: 'ko',
      whisper_model: 'small', devices: { diarization: 'gpu', stt: 'cpu' },
      summary_model: 'qwen3.5:4b-mlx',
    });
    const row = await db.pool.query(`SELECT value FROM app_setting WHERE key='processing_defaults'`);
    expect(row.rows[0].value).toEqual({ preset: 'light', language: 'ko' }); // 이름만 저장 — 개별 값 스냅샷 없음
  });

  it('custom 저장 → 개별 값이 진실', async () => {
    await service.putProcessing({
      preset: 'custom', language: 'ko', whisper_model: 'medium',
      devices: { diarization: 'gpu', stt: 'cpu' },
    });
    const cfg = await service.getProcessingConfig();
    expect(cfg.preset).toBe('custom');
    expect(cfg.preset_revision).toBeNull();
    expect(cfg.whisper_model).toBe('medium');
  });

  it('손상 jsonb → env 폴백 + 예외 없음', async () => {
    await db.pool.query(
      `INSERT INTO app_setting(key, value) VALUES('processing_defaults', '{"preset":"nope"}')`,
    );
    const cfg = await service.getProcessingConfig();
    expect(cfg.preset).toBe('custom'); // env 폴백
  });

  it('레거시 custom 행(summary_model 없음) → env 값으로 읽히고 나머지 값은 보존된다', async () => {
    await db.pool.query(
      `INSERT INTO app_setting(key, value) VALUES('processing_defaults', $1::jsonb)`,
      [JSON.stringify({
        preset: 'custom', language: 'ko', whisper_model: 'medium',
        devices: { diarization: 'gpu', stt: 'cpu' },
      })],
    );
    const cfg = await service.getProcessingConfig();
    expect(cfg.whisper_model).toBe('medium');            // env 폴백으로 날아가지 않는다
    expect(cfg.devices).toEqual({ diarization: 'gpu', stt: 'cpu' });
    expect(cfg.summary_model).toBe('qwen3.5:4b-mlx');    // env 기본값
  });

  it('레거시 행에 PUT하면 summary_model이 명시 값으로 저장된다', async () => {
    await db.pool.query(
      `INSERT INTO app_setting(key, value) VALUES('processing_defaults', $1::jsonb)`,
      [JSON.stringify({
        preset: 'custom', language: 'ko', whisper_model: 'medium',
        devices: { diarization: 'gpu', stt: 'cpu' },
      })],
    );
    await service.putProcessing({
      preset: 'custom', language: 'ko', whisper_model: 'medium',
      devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'qwen3.5:27b-mlx',
    });
    const row = await db.pool.query(`SELECT value FROM app_setting WHERE key='processing_defaults'`);
    expect(row.rows[0].value.summary_model).toBe('qwen3.5:27b-mlx');
  });

  it('custom 저장값의 summary_model이 진실이다', async () => {
    await service.putProcessing({
      preset: 'custom', language: 'ko', whisper_model: 'small',
      devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'qwen3.5:9b-mlx',
    });
    const cfg = await service.getProcessingConfig();
    expect(cfg.summary_model).toBe('qwen3.5:9b-mlx');
  });
});
