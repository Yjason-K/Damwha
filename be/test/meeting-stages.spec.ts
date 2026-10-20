import { toStages } from '../src/meetings/meeting-stages';

describe('toStages', () => {
  it.each([
    ['recording', 'pending'], ['uploaded', 'queued'], ['processing', 'running'],
    ['done', 'done'], ['failed', 'failed'],
  ])('process: meeting %s -> %s', (meeting_status, process) => {
    expect(toStages({ meeting_status, summary_status: null, lens_status: null }).process).toBe(process);
  });

  it.each(['queued', 'running', 'done', 'failed'])('follow-up row %s passes through', (st) => {
    for (const ms of ['processing', 'done', 'failed']) {
      expect(toStages({ meeting_status: ms, summary_status: st, lens_status: st }))
        .toMatchObject({ summary: st, lens: st });
    }
  });

  it.each([
    ['recording', 'pending'], ['uploaded', 'pending'], ['processing', 'pending'],
    ['failed', 'pending'], ['done', 'skipped'],
  ])('no row while meeting %s -> %s', (meeting_status, expected) => {
    expect(toStages({ meeting_status, summary_status: null, lens_status: null }))
      .toEqual(expect.objectContaining({ summary: expected, lens: expected }));
  });

  it('summary and lens are independent', () => {
    expect(toStages({ meeting_status: 'done', summary_status: 'done', lens_status: null }))
      .toEqual({ process: 'done', summary: 'done', lens: 'skipped' });
  });
});
