import { describe, expect, it } from 'vitest';
import type { MeetingStatus, StageState } from '../src/api-types';
import { WaitAbortedError, waitForMeeting } from '../src/wait';

function status(process: StageState, summary: StageState, lens: StageState): MeetingStatus {
  return { stages: { process, summary, lens } };
}

function fakeClient(seq: MeetingStatus[]) {
  let i = 0;
  return { getStatus: async () => seq[Math.min(i++, seq.length - 1)] };
}

const base = { intervalMs: 1, onProgress: () => {} };

describe('waitForMeeting', () => {
  it('ends when skipped stages remain (summary skipped is not pending)', async () => {
    const client = fakeClient([status('running', 'pending', 'pending'), status('done', 'skipped', 'done')]);
    const r = await waitForMeeting(client, 'mtg_1', { ...base, signal: new AbortController().signal });
    expect(r).toEqual({ ok: true, stages: { process: 'done', summary: 'skipped', lens: 'done' }, failed: [] });
  });

  it('keeps polling while any stage is still queued or running', async () => {
    const seq = [status('done', 'running', 'queued'), status('done', 'done', 'running'), status('done', 'done', 'done')];
    const client = { calls: 0, getStatus: async () => seq[Math.min(client.calls++, 2)] };
    const seen: MeetingStatus['stages'][] = [];
    await waitForMeeting(client, 'mtg_1', { ...base, onProgress: (s) => seen.push(s), signal: new AbortController().signal });
    expect(client.calls).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it('reports failed stages and ok=false', async () => {
    const client = fakeClient([status('done', 'failed', 'done')]);
    const r = await waitForMeeting(client, 'mtg_1', { ...base, signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['summary']);
  });

  it('process failure ends the wait because be marks followups skipped', async () => {
    const client = fakeClient([status('failed', 'skipped', 'skipped')]);
    const r = await waitForMeeting(client, 'mtg_1', { ...base, signal: new AbortController().signal });
    expect(r).toMatchObject({ ok: false, failed: ['process'] });
  });

  it('rejects with WaitAbortedError when aborted mid-sleep', async () => {
    const ac = new AbortController();
    const client = fakeClient([status('running', 'pending', 'pending')]);
    const p = waitForMeeting(client, 'mtg_1', { intervalMs: 60_000, onProgress: () => {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(WaitAbortedError);
  });
});
