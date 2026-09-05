import * as fs from 'fs';
import * as path from 'path';
import {
  ProcessMeetingPayloadSchema,
  EnrollSpeakerPayloadSchema,
  IndexMeetingPayloadSchema,
  SummarizeMeetingPayloadSchema,
  LiveSessionPayloadSchema,
} from '../src/contracts/job-payload.schema';

const dir = path.join(__dirname, 'fixtures', 'job-payloads');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

describe('contract fixtures (shared with pydantic worker)', () => {
  it('validates process_meeting.valid.json', () => {
    expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.valid.json'))).not.toThrow();
  });
  it('validates enroll_speaker.valid.json', () => {
    expect(() => EnrollSpeakerPayloadSchema.parse(read('enroll_speaker.valid.json'))).not.toThrow();
  });
  it('accepts process_meeting.no_version.json (defaults to 1)', () => {
    expect(ProcessMeetingPayloadSchema.parse(read('process_meeting.no_version.json')).schema_version).toBe(1);
  });
  it('validates index_meeting.valid.json', () => {
    expect(() => IndexMeetingPayloadSchema.parse(read('index_meeting.valid.json'))).not.toThrow();
  });
  it('rejects process_meeting.invalid_id.json (UUID meeting_id)', () => {
    expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.invalid_id.json'))).toThrow();
  });
  it('validates process_meeting.v2.valid.json', () => {
    const p = ProcessMeetingPayloadSchema.parse(read('process_meeting.v2.valid.json'));
    expect(p.schema_version).toBe(2);
    if (p.schema_version === 2) {
      expect(p.models.devices).toEqual({ diarization: 'gpu', stt: 'cpu' });
      expect(p.models.preset).toBe('light');
    }
  });
  it('still accepts v1 fixture and missing-version fixture as v1', () => {
    expect(ProcessMeetingPayloadSchema.parse(read('process_meeting.valid.json')).schema_version).toBe(1);
    expect(ProcessMeetingPayloadSchema.parse(read('process_meeting.no_version.json')).schema_version).toBe(1);
  });
  it('rejects v2 payload with legacy device field', () => {
    const v2 = read('process_meeting.v2.valid.json');
    v2.models.device = 'mps';
    expect(() => ProcessMeetingPayloadSchema.parse(v2)).toThrow();
  });
  it('validates process_meeting.v3.valid.json', () => {
    const p = ProcessMeetingPayloadSchema.parse(read('process_meeting.v3.valid.json'));
    expect(p.schema_version).toBe(3);
    if (p.schema_version === 3) {
      expect(p.models.summary_model).toBe('mlx-community/Qwen3.5-4B-8bit');
      expect(p.models.preset).toBe('light');
    }
  });
  it('rejects v3 payload missing summary_model (env 폴백 금지)', () => {
    expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.v3.missing_summary_model.json'))).toThrow();
  });
  it('rejects v2 payload carrying summary_model (v2는 그 필드를 모른다)', () => {
    const v2 = read('process_meeting.v2.valid.json');
    v2.models.summary_model = 'mlx-community/Qwen3.5-4B-8bit';
    expect(() => ProcessMeetingPayloadSchema.parse(v2)).toThrow();
  });
  it('validates process_meeting.v4.valid.json', () => {
    const p = ProcessMeetingPayloadSchema.parse(read('process_meeting.v4.valid.json'));
    expect(p.schema_version).toBe(4);
    if (p.schema_version === 4) {
      expect(p.identify).toEqual({ threshold: 0.8, suggest_threshold: 0.6 });
    }
  });
  it('rejects v4 payload whose suggest_threshold exceeds threshold (unreachable band)', () => {
    expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.v4.inverted_band.json'))).toThrow();
  });
  it('rejects v4 payload missing suggest_threshold (worker 기본값 폴백 금지)', () => {
    const v4 = read('process_meeting.v4.valid.json');
    delete v4.identify.suggest_threshold;
    expect(() => ProcessMeetingPayloadSchema.parse(v4)).toThrow();
  });
  it('rejects v3 payload carrying suggest_threshold (v3는 그 필드를 모른다)', () => {
    const v3 = read('process_meeting.v3.valid.json');
    v3.identify.suggest_threshold = 0.6;
    // v1–v3 identify is non-strict, so the field is stripped rather than rejected —
    // what matters is that it never reaches the worker as a real band.
    const parsed = ProcessMeetingPayloadSchema.parse(v3);
    expect((parsed.identify as Record<string, unknown>).suggest_threshold).toBeUndefined();
  });
  it('validates process_meeting.v5.valid.json', () => {
    const p = ProcessMeetingPayloadSchema.parse(read('process_meeting.v5.valid.json'));
    expect(p.schema_version).toBe(5);
    if (p.schema_version === 5) {
      expect(p.followups).toEqual({ lens: false, summary: false });
    }
  });
  it('rejects v5 payload missing followups (워커 기본값 폴백 금지)', () => {
    const v5 = read('process_meeting.v5.valid.json');
    delete v5.followups;
    expect(() => ProcessMeetingPayloadSchema.parse(v5)).toThrow();
  });
  it('rejects v4 payload carrying followups (v4는 그 필드를 모른다)', () => {
    const v4 = read('process_meeting.v4.valid.json');
    v4.followups = { lens: false, summary: false };
    // v4 스키마는 non-strict라 필드가 떨어져 나간다 — 중요한 건 워커에 스위치로
    // 도달하지 않는 것이고, 그쪽에서는 v4가 항상 둘 다 켠 것으로 변환된다.
    const parsed = ProcessMeetingPayloadSchema.parse(v4);
    expect((parsed as Record<string, unknown>).followups).toBeUndefined();
  });
  it('validates summarize-meeting-v1.json', () => {
    expect(() => SummarizeMeetingPayloadSchema.parse(read('summarize-meeting-v1.json'))).not.toThrow();
  });
  it('rejects summarize-meeting-v1.json with an unknown extraction_run_id field', () => {
    const withExtraField = { ...read('summarize-meeting-v1.json'), extraction_run_id: 'ler_1' };
    expect(() => SummarizeMeetingPayloadSchema.parse(withExtraField)).toThrow();
  });
  it('validates live_session.valid.json and its embedded v5 process payload', () => {
    const p = LiveSessionPayloadSchema.parse(read('live_session.valid.json'));
    expect(p.source).toBe('mic');
    expect(p.process.schema_version).toBe(5);
    expect(p.process.audio_key).toBe(p.audio_key);
  });
  it('rejects live_session whose process block is not v5', () => {
    const bad = read('live_session.valid.json');
    bad.process = { ...bad.process, schema_version: 4 };
    delete bad.process.followups;
    expect(() => LiveSessionPayloadSchema.parse(bad)).toThrow();
  });
  it('rejects live_session with an unknown source', () => {
    const bad = read('live_session.valid.json');
    bad.source = 'system';
    expect(() => LiveSessionPayloadSchema.parse(bad)).toThrow();
  });
});
