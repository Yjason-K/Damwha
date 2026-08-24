-- A lens assignment is historical meeting context, not ownership of a speaker.
-- Speaker deletion must preserve the lens item while clearing its assignee.
ALTER TABLE lens_item DROP CONSTRAINT lens_item_assignee_speaker_id_fkey;
ALTER TABLE lens_item
  ADD CONSTRAINT lens_item_assignee_speaker_id_fkey
  FOREIGN KEY (assignee_speaker_id) REFERENCES speaker(id) ON DELETE SET NULL;
