-- Two-tier speaker identification: record the near-miss candidate.
--
-- Identification now compares a meeting's clusters against 'provisional' speakers
-- too, not just 'ready' ones — without that, a fresh install (which has no 'ready'
-- speaker until a human renames one) could never link the same person across two
-- meetings. Because that widens the candidate set, binding is split in two: a
-- score at or above identify.threshold binds outright, while the band down to
-- identify.suggest_threshold is too close to call. A banded cluster still gets its
-- own provisional speaker, and the candidate is parked here for the user to
-- confirm through POST /meetings/:id/clusters/:clusterId/resolve.
--
-- ON DELETE SET NULL, not CASCADE: a suggestion is a hint, so deleting the
-- suggested speaker must drop the hint, never the cluster it points from.

ALTER TABLE meeting_cluster
  ADD COLUMN suggested_speaker_id text REFERENCES speaker(id) ON DELETE SET NULL,
  ADD COLUMN suggested_similarity real;

-- A candidate must always carry the score that produced it — otherwise the UI has
-- a merge to offer and no confidence to show. The reverse is deliberately allowed:
-- the FK above fires ON DELETE SET NULL, which clears the id and cannot touch the
-- score, so a two-sided equality here would make deleting a suggested speaker fail
-- outright. A leftover score with no id is inert — every reader gates on the id.
ALTER TABLE meeting_cluster
  ADD CONSTRAINT meeting_cluster_suggestion_scored
  CHECK (suggested_speaker_id IS NULL OR suggested_similarity IS NOT NULL);

-- resolved_speaker_id and suggested_speaker_id coexist by design: a banded cluster
-- gets its OWN fresh provisional speaker (so its utterances are still attributed)
-- while the near-miss candidate rides along as "this may be the same person".
-- Suggesting the speaker the cluster already resolves to would be a no-op merge.
ALTER TABLE meeting_cluster
  ADD CONSTRAINT meeting_cluster_suggestion_not_self
  CHECK (suggested_speaker_id IS NULL OR suggested_speaker_id IS DISTINCT FROM resolved_speaker_id);

CREATE INDEX meeting_cluster_suggested_speaker_idx
  ON meeting_cluster(suggested_speaker_id)
  WHERE suggested_speaker_id IS NOT NULL;
