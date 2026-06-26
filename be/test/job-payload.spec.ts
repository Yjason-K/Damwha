import {
  ProcessMeetingPayloadSchema,
  EnrollSpeakerPayloadSchema,
  buildProcessMeetingPayload,
  buildEnrollSpeakerPayload,
  buildIndexMeetingPayload,
  IndexMeetingPayloadSchema,
} from '../src/contracts/job-payload.schema';

describe('job payload contract', () => {
  beforeAll(() => {
    // loadEnv() (used by the build* helpers) requires DATABASE_URL; this
    // standalone unit test has no DB harness, so provide a dummy.
    process.env.DATABASE_URL ??= 'postgres://localhost/test';
    process.env.WHISPER_MODEL = 'large-v3-turbo';
    process.env.EMBEDDING_DIM = '192';
    process.env.IDENTIFY_THRESHOLD = '0.7';
  });

  it('builds + validates a process_meeting payload from ENV', () => {
    const p = buildProcessMeetingPayload({
      meetingId: '11111111-1111-1111-1111-111111111111',
      audioKey: 'meetings/x/original.wav',
      processingVersion: 2,
      reprocess: true,
    });
    expect(p.models.whisper_model).toBe('large-v3-turbo');
    expect(p.models.embedding.dimension).toBe(192);
    expect(p.identify.threshold).toBeCloseTo(0.7);
    expect(() => ProcessMeetingPayloadSchema.parse(p)).not.toThrow();
  });

  it('rejects a process_meeting payload missing audio_key', () => {
    expect(() => ProcessMeetingPayloadSchema.parse({ meeting_id: 'x' })).toThrow();
  });

  it('builds + validates an enroll_speaker payload', () => {
    const p = buildEnrollSpeakerPayload({
      speakerId: '22222222-2222-2222-2222-222222222222',
      audioKey: 'speakers/y/sample.wav',
    });
    expect(() => EnrollSpeakerPayloadSchema.parse(p)).not.toThrow();
    expect(p.embedding.dimension).toBe(192);
  });

  it('stamps schema_version=1 on process_meeting payload', () => {
    const p = buildProcessMeetingPayload({
      meetingId: '11111111-1111-1111-1111-111111111111',
      audioKey: 'meetings/x/original.wav',
      processingVersion: 2,
      reprocess: true,
    });
    expect(p.schema_version).toBe(1);
    expect(() => ProcessMeetingPayloadSchema.parse(p)).not.toThrow();
  });

  it('defaults missing schema_version to 1', () => {
    const raw = {
      meeting_id: '11111111-1111-1111-1111-111111111111',
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
      speakerId: '22222222-2222-2222-2222-222222222222',
      audioKey: 'speakers/y/sample.wav',
    });
    expect(p.schema_version).toBe(1);
  });

  it('builds + validates an index_meeting payload from ENV', () => {
    process.env.SEARCH_EMBEDDING_MODEL = 'BAAI/bge-m3';
    process.env.SEARCH_EMBEDDING_DIM = '1024';
    const p = buildIndexMeetingPayload({
      meetingId: '11111111-1111-1111-1111-111111111111',
      processingVersion: 3,
    });
    expect(p.schema_version).toBe(1);
    expect(p.processing_version).toBe(3);
    expect(p.search_embedding).toEqual({ model: 'BAAI/bge-m3', dimension: 1024 });
    expect(() => IndexMeetingPayloadSchema.parse(p)).not.toThrow();
  });
});
