import { classifyAiMerge } from '../src/lenses/lenses.service';
import { AiLensCandidate, ExistingLensForMerge } from '../src/lenses/lens.types';

const cand = (over: Partial<AiLensCandidate> = {}): AiLensCandidate => ({
  kind: 'action', text: 't', assignee_speaker_id: null, due_at: null,
  primary_utterance_id: 'utt_1', supporting_utterance_ids: [], ...over,
});

const item = (over: Partial<ExistingLensForMerge> = {}): ExistingLensForMerge => ({
  id: 'lens_x', kind: 'action', source: 'ai', user_modified: false,
  lifecycle_status: 'active', completion_status: 'open', primary_utterance_id: 'utt_1', ...over,
});

describe('classifyAiMerge', () => {
  it('updates matches, creates unmatched candidates, then archives unmatched eligible rows', () => {
    const existing = [
      item({ id: 'lens_1', kind: 'action', primary_utterance_id: 'utt_1' }),
      item({ id: 'lens_2', kind: 'decision', primary_utterance_id: 'utt_2' }),
    ];
    const candidates = [
      cand({ kind: 'action', primary_utterance_id: 'utt_1' }),
      cand({ kind: 'promise', primary_utterance_id: 'utt_3' }),
    ];

    expect(classifyAiMerge(existing, candidates)).toEqual([
      { type: 'update', lens_id: 'lens_1', candidate: candidates[0] },
      { type: 'create', candidate: candidates[1] },
      { type: 'archive', lens_id: 'lens_2' },
    ]);
  });

  it('never updates or archives ineligible items even when a candidate shares their key', () => {
    const existing = [
      item({ id: 'lens_user', source: 'user' }),
      item({ id: 'lens_edited', source: 'edited' }),
      item({ id: 'lens_modified', user_modified: true }),
      item({ id: 'lens_done', completion_status: 'done' }),
      item({ id: 'lens_archived', lifecycle_status: 'archived' }),
    ];
    // This candidate's key matches every ineligible row above.
    const candidates = [cand({ kind: 'action', primary_utterance_id: 'utt_1' })];

    // Ineligible rows are invisible: the candidate can only become a create,
    // and no update/archive decision references any of them.
    expect(classifyAiMerge(existing, candidates)).toEqual([
      { type: 'create', candidate: candidates[0] },
    ]);
  });
});
