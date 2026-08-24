import { audioContentType } from '../src/storage/content-type';

describe('audioContentType', () => {
  it('maps the formats the pipeline produces and accepts', () => {
    expect(audioContentType('meetings/x/normalized.flac')).toBe('audio/flac');
    expect(audioContentType('meetings/x/normalized.wav')).toBe('audio/wav');
    expect(audioContentType('meetings/x/original.m4a')).toBe('audio/mp4');
    expect(audioContentType('meetings/x/original.mp3')).toBe('audio/mpeg');
    expect(audioContentType('meetings/x/original.webm')).toBe('audio/webm');
    expect(audioContentType('meetings/x/original.ogg')).toBe('audio/ogg');
  });

  it('is case-insensitive', () => {
    expect(audioContentType('meetings/x/A.FLAC')).toBe('audio/flac');
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(audioContentType('meetings/x/original.xyz')).toBe('application/octet-stream');
    expect(audioContentType('meetings/x/original')).toBe('application/octet-stream');
  });
});
