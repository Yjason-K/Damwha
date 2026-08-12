import {
  ProcessMeetingPayloadSchema,
  EnrollSpeakerPayloadSchema,
  buildProcessMeetingPayload,
  buildEnrollSpeakerPayload,
  buildIndexMeetingPayload,
  IndexMeetingPayloadSchema,
  ExtractLensesPayloadSchema,
  buildExtractLensesPayload,
  SummarizeMeetingPayloadSchema,
  buildSummarizeMeetingPayload,
} from '../src/contracts/job-payload.schema';
import { loadEnv } from '../src/config/env';
import { resolvePreset } from '../src/settings/presets';

describe('job payload contract', () => {
  beforeAll(() => {
    // loadEnv() (used by the build* helpers) requires DATABASE_URL; this
    // standalone unit test has no DB harness, so provide a dummy.
    process.env.DATABASE_URL ??= 'postgres://localhost/test';
    process.env.WHISPER_MODEL = 'large-v3-turbo';
    process.env.EMBEDDING_DIM = '192';
    process.env.IDENTIFY_THRESHOLD = '0.7';
  });

  it('builds + validates a process_meeting payload (설정 주입)', () => {
    const p = buildProcessMeetingPayload({
      meetingId: 'mtg_1', audioKey: 'meetings/x/original.wav',
      processingVersion: 2, reprocess: true,
      processing: resolvePreset('standard', 'ko'),
    });
    expect(p.schema_version).toBe(3);
    expect(p.models.whisper_model).toBe('large-v3-turbo');
    expect(p.models.devices).toEqual({ diarization: 'gpu', stt: 'gpu' });
    expect(p.models.preset).toBe('standard');
    expect(p.models.embedding.dimension).toBe(192);
    expect(p.models.summary_model).toBe('qwen3.5:8b-mlx');
    expect(() => ProcessMeetingPayloadSchema.parse(p)).not.toThrow();
  });

  it('rejects a process_meeting payload missing audio_key', () => {
    expect(() => ProcessMeetingPayloadSchema.parse({ meeting_id: 'x' })).toThrow();
  });

  it('builds + validates an enroll_speaker payload', () => {
    const p = buildEnrollSpeakerPayload({
      speakerId: 'spk_1',
      audioKey: 'speakers/y/sample.wav',
    });
    expect(() => EnrollSpeakerPayloadSchema.parse(p)).not.toThrow();
    expect(p.embedding.dimension).toBe(192);
  });

  it('stamps schema_version=3 on process_meeting payload', () => {
    const p = buildProcessMeetingPayload({
      meetingId: 'mtg_1',
      audioKey: 'meetings/x/original.wav',
      processingVersion: 2,
      reprocess: true,
      processing: resolvePreset('standard', 'ko'),
    });
    expect(p.schema_version).toBe(3);
    expect(() => ProcessMeetingPayloadSchema.parse(p)).not.toThrow();
  });

  it('defaults missing schema_version to 1', () => {
    const raw = {
      meeting_id: 'mtg_1',
      audio_key: 'meetings/x/original.wav',
      processing_version: 0, reprocess: false,
      models: {
        whisper_model: 'large-v3-turbo', device: 'mps', language: 'ko',
        diarization: { model: 'd', min_speakers: null, max_speakers: null },
        embedding: { model: 'e', dimension: 192 },
      },
      identify: { threshold: 0.7 },
    };
    expect(ProcessMeetingPayloadSchema.parse(raw).schema_version).toBe(1);
  });

  it('stamps schema_version=1 on enroll_speaker payload', () => {
    const p = buildEnrollSpeakerPayload({
      speakerId: 'spk_1',
      audioKey: 'speakers/y/sample.wav',
    });
    expect(p.schema_version).toBe(1);
  });

  it('builds + validates an index_meeting payload from ENV', () => {
    process.env.SEARCH_EMBEDDING_MODEL = 'BAAI/bge-m3';
    process.env.SEARCH_EMBEDDING_DIM = '1024';
    const p = buildIndexMeetingPayload({
      meetingId: 'mtg_1',
      processingVersion: 3,
    });
    expect(p.schema_version).toBe(1);
    expect(p.processing_version).toBe(3);
    expect(p.search_embedding).toEqual({ model: 'BAAI/bge-m3', dimension: 1024 });
    expect(() => IndexMeetingPayloadSchema.parse(p)).not.toThrow();
  });

  it('accepts only extract_lenses v1 payloads', () => {
    const payload = {
      schema_version: 1,
      meeting_id: 'mtg_1',
      processing_version: 0,
      extraction_run_id: 'ler_1',
      model: 'qwen2.5:14b-instruct',
    };
    expect(ExtractLensesPayloadSchema.parse(payload).extraction_run_id).toBe('ler_1');
    expect(() => ExtractLensesPayloadSchema.parse({ schema_version: 2 })).toThrow();
  });

  it('rejects unknown keys in an extract_lenses payload', () => {
    expect(() => ExtractLensesPayloadSchema.parse({
      schema_version: 1,
      meeting_id: 'mtg_1',
      processing_version: 0,
      extraction_run_id: 'ler_1',
      model: 'qwen2.5:14b-instruct',
      unexpected: true,
    })).toThrow();
  });

  it('builds an extract_lenses payload with the provided execution context', () => {
    const payload = buildExtractLensesPayload({
      meetingId: 'mtg_1',
      processingVersion: 0,
      extractionRunId: 'ler_1',
      model: 'qwen2.5:14b-instruct',
    });
    expect(payload).toEqual({
      schema_version: 1,
      meeting_id: 'mtg_1',
      processing_version: 0,
      extraction_run_id: 'ler_1',
      model: 'qwen2.5:14b-instruct',
    });
  });

  it('builds + validates a summarize_meeting payload (extraction_run_id 없음)', () => {
    const payload = buildSummarizeMeetingPayload({
      meetingId: 'mtg_1',
      processingVersion: 0,
      model: 'qwen3.5:4b-mlx',
    });
    expect(payload).toEqual({
      schema_version: 1,
      meeting_id: 'mtg_1',
      processing_version: 0,
      model: 'qwen3.5:4b-mlx',
    });
    expect(() => SummarizeMeetingPayloadSchema.parse(payload)).not.toThrow();
  });

  it('rejects unknown keys in a summarize_meeting payload', () => {
    expect(() => SummarizeMeetingPayloadSchema.parse({
      schema_version: 1,
      meeting_id: 'mtg_1',
      processing_version: 0,
      model: 'qwen3.5:4b-mlx',
      extraction_run_id: 'ler_1',
    })).toThrow();
  });

  it('defaults LENS_LLM_MODEL to the extraction model', () => {
    const old = process.env.LENS_LLM_MODEL;
    delete process.env.LENS_LLM_MODEL;
    expect(loadEnv().LENS_LLM_MODEL).toBe('qwen3.5:4b-mlx');
    if (old === undefined) delete process.env.LENS_LLM_MODEL;
    else process.env.LENS_LLM_MODEL = old;
  });

  it('rejects UUID, zero, and unicode-digit ids', () => {
    const base = buildProcessMeetingPayload({
      meetingId: 'mtg_1', audioKey: 'meetings/mtg_1/o.wav', processingVersion: 0, reprocess: false,
      processing: resolvePreset('standard', 'ko'),
    });
    for (const bad of ['ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca', 'mtg_0', 'mtg_1٢']) { // 마지막은 유니코드 숫자
      expect(() => ProcessMeetingPayloadSchema.parse({ ...base, meeting_id: bad })).toThrow();
    }
  });
});
