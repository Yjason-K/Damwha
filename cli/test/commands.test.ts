import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import desktopPkg from '../../desktop/package.json';
import type { StageState } from '../src/api-types';
import type { DamwhaClient } from '../src/client';
import type { ConnectionResult } from '../src/connection';
import { ApiRequestError } from '../src/errors';
import { MESSAGES } from '../src/messages';
import { run, type RunIo } from '../src/run';

let dir: string;
let audio: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'damwha-cli-'));
  writeFileSync(join(dir, 'ui-language.json'), JSON.stringify({ language: 'en' }));
  audio = join(dir, 'a.m4a');
  writeFileSync(audio, 'x');
});

type Fake = Partial<Record<keyof DamwhaClient, (...a: any[]) => unknown>>;

async function exec(argv: string[], fake: Fake = {}, conn: ConnectionResult = { kind: 'ok', baseUrl: 'http://h/api' }, extra: Partial<RunIo> = {}) {
  let out = '';
  let err = '';
  const io: RunIo = {
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    env: {},
    now: () => new Date('2026-10-20T00:00:00Z'),
    userDataDir: dir,
    connect: async () => conn,
    createClient: () => fake as unknown as DamwhaClient,
    waitIntervalMs: 1,
    ...extra,
  };
  const code = await run(argv, io);
  return { code, out, err };
}

const stages = (process: StageState, summary: StageState, lens: StageState) => ({ stages: { process, summary, lens } });

describe('run', () => {
  it('--version prints the desktop app version (CLI ships inside the app)', async () => {
    const r = await exec(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(desktopPkg.version);
  });

  it('not_running -> exit 2 with notRunning message', async () => {
    const r = await exec(['meetings'], {}, { kind: 'not_running' });
    expect(r.code).toBe(2);
    expect(r.err).toContain(MESSAGES.en.notRunning);
  });

  it('starting -> exit 2 with starting message', async () => {
    const r = await exec(['meetings'], {}, { kind: 'starting' });
    expect(r.code).toBe(2);
    expect(r.err).toContain(MESSAGES.en.starting);
  });

  it('invalid option -> exit 1 lists the option and allowed values', async () => {
    const upload = vi.fn();
    const r = await exec(['upload', audio, '--preset', 'bogus'], { upload });
    expect(r.code).toBe(1);
    expect(r.err).toContain('--preset');
    expect(r.err).toContain('light');
    expect(r.err).toContain('quality');
    expect(upload).not.toHaveBeenCalled();
  });

  it('missing upload file -> exit 1 with a clear message, no API call', async () => {
    const upload = vi.fn();
    const r = await exec(['upload', join(dir, 'nope.m4a')], { upload });
    expect(r.code).toBe(1);
    expect(r.err).toContain('nope.m4a');
    expect(r.err).not.toContain('ENOENT');
    expect(upload).not.toHaveBeenCalled();
  });

  it('--no-summary/--no-lens reach the multipart form as defer_* fields', async () => {
    const upload = vi.fn(async (_f: FormData) => ({ id: 'mtg_1' }));
    const r = await exec(['upload', audio, '--no-summary', '--no-lens'], { upload, listModels: async () => ({ models: [] }) });
    expect(r.code).toBe(0);
    const form = upload.mock.calls[0][0];
    expect(form.get('defer_summary')).toBe('true');
    expect(form.get('defer_lens')).toBe('true');
    expect(r.out).toContain('mtg_1');
  });

  it('without --no-* flags no defer fields are sent', async () => {
    const upload = vi.fn(async (_f: FormData) => ({ id: 'mtg_1' }));
    await exec(['upload', audio], { upload, listModels: async () => ({ models: [] }) });
    const form = upload.mock.calls[0][0];
    expect(form.get('defer_summary')).toBeNull();
    expect(form.get('defer_lens')).toBeNull();
  });

  it('upload warns when models are not ready but still uploads', async () => {
    const upload = vi.fn(async () => ({ id: 'mtg_1' }));
    const listModels = async () => ({ models: [{ role: 'stt', name: 'large-v3', inUseFor: ['stt'], installed: 'no' }] });
    const r = await exec(['upload', audio], { upload, listModels });
    expect(r.code).toBe(0);
    expect(r.err).toContain(MESSAGES.en.modelsNotReady);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('upload --wait exits 3 and prints the meeting id when a stage failed', async () => {
    const r = await exec(['upload', audio, '--wait'], {
      upload: async () => ({ id: 'mtg_9' }),
      listModels: async () => ({ models: [] }),
      getStatus: async () => stages('done', 'failed', 'done'),
      listLenses: async () => ({ items: [], next_cursor: null, total: 2 }),
    });
    expect(r.code).toBe(3);
    expect(r.err).toContain('summary');
    expect(r.err + r.out).toContain('mtg_9');
  });

  it('upload --wait --json prints stages and lens count on success', async () => {
    const r = await exec(['upload', audio, '--wait', '--json'], {
      upload: async () => ({ id: 'mtg_9' }),
      listModels: async () => ({ models: [] }),
      getStatus: async () => stages('done', 'skipped', 'done'),
      listLenses: async () => ({ items: [], next_cursor: null, total: 3 }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ id: 'mtg_9', stages: { summary: 'skipped' }, lens_count: 3 });
  });

  it('SIGINT while waiting -> waitInterrupted message, exit 0', async () => {
    const ac = new AbortController();
    const r = await exec(
      ['upload', audio, '--wait'],
      {
        upload: async () => ({ id: 'mtg_9' }),
        listModels: async () => ({ models: [] }),
        getStatus: async () => {
          setTimeout(() => ac.abort(), 1);
          return stages('running', 'pending', 'pending');
        },
      },
      undefined,
      { signal: ac.signal, waitIntervalMs: 60_000 },
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain(MESSAGES.en.waitInterrupted);
    expect(r.err + r.out).toContain('mtg_9');
  });

  it('Ctrl-C during a hung non-wait request resolves promptly with 130', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const r = await exec(['meetings'], { listMeetings: () => new Promise(() => {}) }, undefined, { signal: ac.signal });
    expect(r.code).toBe(130);
  });

  it('Ctrl-C during a hung status fetch in --wait -> waitInterrupted + id, exit 0', async () => {
    const ac = new AbortController();
    const r = await exec(
      ['upload', audio, '--wait'],
      {
        upload: async () => ({ id: 'mtg_9' }),
        listModels: async () => ({ models: [] }),
        getStatus: () => {
          setTimeout(() => ac.abort(), 5);
          return new Promise(() => {});
        },
      },
      undefined,
      { signal: ac.signal },
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain(MESSAGES.en.waitInterrupted);
    expect(r.err).toContain('mtg_9');
    expect(r.err.match(new RegExp(MESSAGES.en.waitInterrupted.slice(0, 20), 'g'))).toHaveLength(1);
  });

  it('Ctrl-C during the upload POST itself exits 130', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const r = await exec(['upload', audio, '--wait'], { upload: () => new Promise(() => {}), listModels: async () => ({ models: [] }) }, undefined, { signal: ac.signal });
    expect(r.code).toBe(130);
  });

  it('lenses --mine without an is_me speaker -> exit 1 noMeSpeaker', async () => {
    const listLenses = vi.fn();
    const r = await exec(['lenses', '--mine'], { listSpeakers: async () => [{ id: 'spk_1', name: 'A', is_me: false }], listLenses });
    expect(r.code).toBe(1);
    expect(r.err).toContain(MESSAGES.en.noMeSpeaker);
    expect(listLenses).not.toHaveBeenCalled();
  });

  it('lenses --mine filters by the is_me speaker and maps flags', async () => {
    const listLenses = vi.fn(async () => ({ items: [], next_cursor: null, total: 0 }));
    const r = await exec(
      ['lenses', '--mine', '--open', '--kind', 'todo', '--due-from', '2026-01-01', '--limit', '5'],
      { listSpeakers: async () => [{ id: 'spk_7', name: 'Me', is_me: true }], listLenses },
    );
    expect(r.code).toBe(0);
    expect(listLenses).toHaveBeenCalledWith(
      expect.objectContaining({ speaker_id: 'spk_7', completion_status: 'open', kind: 'todo', due_from: '2026-01-01', limit: 5 }),
    );
  });

  it('API error -> exit 1 with its message', async () => {
    const r = await exec(['meeting', 'mtg_x'], { getMeeting: async () => { throw new ApiRequestError('meeting not found', 404); } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('meeting not found');
  });

  it('2xx non-JSON body (SyntaxError) -> one-line error, no stack', async () => {
    const r = await exec(['meetings'], { listMeetings: async () => { throw new SyntaxError('Unexpected token <'); } });
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).not.toContain(' at ');
  });

  it('network error -> one-line error, exit 1', async () => {
    const r = await exec(['meetings'], { listMeetings: async () => { throw new TypeError('fetch failed'); } });
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
  });

  it('meetings --json prints the page', async () => {
    const page = { items: [{ id: 'mtg_1', title: 'T', recorded_at: '2026-01-01T00:00:00Z' }], next_cursor: null };
    const r = await exec(['meetings', '--json'], { listMeetings: async () => page });
    expect(JSON.parse(r.out)).toEqual(page);
  });

  it('text output shows the untitled fallback instead of null', async () => {
    const m = { id: 'mtg_1', title: null, recorded_at: '2026-01-01T00:00:00Z' };
    const list = await exec(['meetings'], { listMeetings: async () => ({ items: [m], next_cursor: null }) });
    expect(list.out).toContain(MESSAGES.en.untitledMeeting);
    expect(list.out).not.toContain('null');
    const one = await exec(['meeting', 'mtg_1'], { getMeeting: async () => m });
    expect(one.out.split('\n')[0]).toBe(MESSAGES.en.untitledMeeting);
    const lens = {
      id: 'lns_1', kind: 'action', text: 'Do it', completion_status: 'open', due_at: null, meeting_id: 'mtg_1',
      meeting: { id: 'mtg_1', title: null, recorded_at: 'r' },
    };
    const l = await exec(['lenses'], { listLenses: async () => ({ items: [lens], next_cursor: null, total: 1 }) });
    expect(l.out).toContain(`(${MESSAGES.en.untitledMeeting}, mtg_1)`);
    const s = await exec(['search', 'x'], {
      search: async () => ({
        mode: 'hybrid', semantic: true, hasMore: false,
        results: [{ utteranceId: 'u', meetingId: 'mtg_1', meetingTitle: null, recordedAt: '2026-01-01', speaker: null, startMs: 0, endMs: 1, text: 'hi', score: 1 }],
      }),
    });
    expect(s.out).toContain(`(${MESSAGES.en.untitledMeeting})`);
  });

  it('search maps flags to the request body', async () => {
    const search = vi.fn(async () => ({ mode: 'hybrid', semantic: true, hasMore: false, results: [] }));
    const r = await exec(['search', 'budget', '--limit', '3', '--from', '2026-01-01', '--meeting', 'mtg_2'], { search });
    expect(r.code).toBe(0);
    expect(search).toHaveBeenCalledWith({ q: 'budget', limit: 3, filters: { dateFrom: '2026-01-01', meetingIds: ['mtg_2'] } });
  });

  it('transcript passes offset/limit', async () => {
    const getTranscript = vi.fn(async () => ({ meeting_id: 'mtg_1', processing_version: 1, total: 0, offset: 10, limit: 20, next_offset: null, utterances: [] }));
    const r = await exec(['transcript', 'mtg_1', '--offset', '10', '--limit', '20'], { getTranscript });
    expect(r.code).toBe(0);
    expect(getTranscript).toHaveBeenCalledWith('mtg_1', { offset: 10, limit: 20 });
  });

  it('status reports not running with exit 2 without needing a client', async () => {
    const r = await exec(['status'], {}, { kind: 'not_running' });
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain(MESSAGES.en.notRunning);
  });

  it('unknown command -> exit 1', async () => {
    const r = await exec(['bogus']);
    expect(r.code).toBe(1);
  });
});
