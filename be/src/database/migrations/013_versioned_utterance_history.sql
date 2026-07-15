-- Reprocessing retains the prior utterance rows so lens evidence remains valid.
-- The same order_index is valid once per processing version.
ALTER TABLE utterance DROP CONSTRAINT utterance_meeting_id_order_index_key;
ALTER TABLE utterance ADD CONSTRAINT utterance_meeting_id_processing_version_order_index_key
  UNIQUE (meeting_id, processing_version, order_index);

-- A lens item's evidence may only cite an utterance from that item's meeting.
-- This is deferred because extraction writes the lens item and its evidence in
-- the same transaction.
CREATE FUNCTION lens_evidence_meeting_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM lens_item li
    JOIN utterance u ON u.id = NEW.utterance_id
    WHERE li.id = NEW.lens_item_id AND li.meeting_id = u.meeting_id
  ) THEN
    RAISE EXCEPTION 'lens evidence utterance must belong to the lens item meeting';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER lens_evidence_meeting_matches_trigger
AFTER INSERT OR UPDATE OF lens_item_id, utterance_id ON lens_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION lens_evidence_meeting_matches();
