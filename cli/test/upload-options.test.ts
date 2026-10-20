import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import { buildUploadForm, parseUploadOptions, resolveFolderId } from '../src/upload-options';

const mtime = new Date('2026-10-01T09:30:00.000Z');

async function formOf(raw: Record<string, unknown>, folderId?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'damwha-cli-'));
  const file = join(dir, 'meeting.m4a');
  writeFileSync(file, 'audio-bytes');
  return buildUploadForm(file, parseUploadOptions(raw), folderId, mtime);
}

describe('buildUploadForm', () => {
  it('--speakers 3 -> speakers {"min":3,"max":3}', async () => {
    const f = await formOf({ speakers: '3' });
    expect(JSON.parse(f.get('speakers') as string)).toEqual({ min: 3, max: 3 });
  });

  it('only --stt-device cpu -> processing {"devices":{"stt":"cpu"}}', async () => {
    const f = await formOf({ 'stt-device': 'cpu' });
    expect(JSON.parse(f.get('processing') as string)).toEqual({ devices: { stt: 'cpu' } });
  });

  it('preset + language -> processing has both', async () => {
    const f = await formOf({ preset: 'quality', language: 'ko' });
    expect(JSON.parse(f.get('processing') as string)).toEqual({ preset: 'quality', language: 'ko' });
  });

  it('no processing flags -> no processing field', async () => {
    const f = await formOf({});
    expect(f.has('processing')).toBe(false);
    expect(f.has('speakers')).toBe(false);
    expect(f.has('defer_lens')).toBe(false);
  });

  it('--no-lens -> defer_lens "true"; --no-summary -> defer_summary "true"', async () => {
    const f = await formOf({ 'no-lens': true, 'no-summary': true });
    expect(f.get('defer_lens')).toBe('true');
    expect(f.get('defer_summary')).toBe('true');
  });

  it('recorded_at defaults to file mtime ISO', async () => {
    const f = await formOf({});
    expect(f.get('recorded_at')).toBe('2026-10-01T09:30:00.000Z');
  });

  it('sends audio with original file name, title and folder_id', async () => {
    const f = await formOf({ title: '주간 회의' }, 'fld_2');
    const audio = f.get('audio') as File;
    expect(audio.name).toBe('meeting.m4a');
    expect(await audio.text()).toBe('audio-bytes');
    expect(f.get('title')).toBe('주간 회의');
    expect(f.get('folder_id')).toBe('fld_2');
  });
});

describe('parseUploadOptions', () => {
  it('bad preset -> UsageError listing the allowed values', () => {
    const err = (() => {
      try { parseUploadOptions({ preset: 'turbo' }); } catch (e) { return e; }
    })() as UsageError;
    expect(err).toBeInstanceOf(UsageError);
    expect(err.option).toBe('preset');
    expect(err.allowed).toEqual(['light', 'standard', 'quality']);
  });

  it('speakers together with min/max -> UsageError', () => {
    expect(() => parseUploadOptions({ speakers: '3', 'min-speakers': '2' })).toThrow(UsageError);
  });

  it('speakers out of range, non-integer, or min > max -> UsageError', () => {
    expect(() => parseUploadOptions({ speakers: '0' })).toThrow(UsageError);
    expect(() => parseUploadOptions({ speakers: '21' })).toThrow(UsageError);
    expect(() => parseUploadOptions({ speakers: '2.5' })).toThrow(UsageError);
    expect(() => parseUploadOptions({ 'min-speakers': '5', 'max-speakers': '2' })).toThrow(UsageError);
  });

  it('rejects bad device, language, whisper model, recorded-at', () => {
    expect(() => parseUploadOptions({ 'stt-device': 'tpu' })).toThrow(UsageError);
    expect(() => parseUploadOptions({ 'diarization-device': 'x' })).toThrow(UsageError);
    expect(() => parseUploadOptions({ language: 'fr' })).toThrow(UsageError);
    expect(() => parseUploadOptions({ 'whisper-model': 'huge' })).toThrow(UsageError);
    expect(() => parseUploadOptions({ 'recorded-at': 'yesterday' })).toThrow(UsageError);
  });

  it('accepts camelCase keys (MCP) the same as kebab-case (CLI)', () => {
    expect(parseUploadOptions({ sttDevice: 'gpu', minSpeakers: 2 })).toMatchObject({
      sttDevice: 'gpu',
      speakers: { min: 2 },
    });
  });
});

describe('resolveFolderId', () => {
  const client = (names: string[]) => ({
    listFolders: async () => names.map((name, i) => ({ id: `fld_${i + 1}`, name })),
  });

  it('passes fld_N through without a lookup', async () => {
    const c = { listFolders: async () => { throw new Error('should not call'); } };
    expect(await resolveFolderId(c, 'fld_7')).toBe('fld_7');
  });

  it('resolves a unique name', async () => {
    expect(await resolveFolderId(client(['a', 'b']), 'b')).toBe('fld_2');
  });

  it('zero or several matches -> UsageError', async () => {
    await expect(resolveFolderId(client(['a']), 'z')).rejects.toBeInstanceOf(UsageError);
    await expect(resolveFolderId(client(['a', 'a']), 'a')).rejects.toBeInstanceOf(UsageError);
  });
});
