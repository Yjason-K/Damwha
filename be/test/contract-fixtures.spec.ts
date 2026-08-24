import * as fs from 'fs';
import * as path from 'path';
import {
  ProcessMeetingPayloadSchema,
  EnrollSpeakerPayloadSchema,
  IndexMeetingPayloadSchema,
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
});
