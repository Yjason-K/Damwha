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
});
