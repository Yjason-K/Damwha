-- An active AI-generated lens item is only valid when it retains a primary
-- evidence row.  The checks are deferred so extraction and primary-evidence
-- replacement may occur in a single transaction.
CREATE FUNCTION assert_active_ai_lens_has_primary(target_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM lens_item li
    WHERE li.id = target_id
      AND li.source = 'ai'
      AND li.lifecycle_status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM lens_evidence le
        WHERE le.lens_item_id = li.id AND le.relation = 'primary'
      )
  ) THEN
    RAISE EXCEPTION 'active AI lens item must have primary evidence'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION active_ai_lens_has_primary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_ai_lens_has_primary(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION active_ai_lens_evidence_insert_has_primary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_ai_lens_has_primary(NEW.lens_item_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION active_ai_lens_evidence_update_has_primary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_ai_lens_has_primary(OLD.lens_item_id);
  PERFORM assert_active_ai_lens_has_primary(NEW.lens_item_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION active_ai_lens_evidence_delete_has_primary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_ai_lens_has_primary(OLD.lens_item_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER active_ai_lens_item_primary_evidence_trigger
AFTER INSERT OR UPDATE OF source, lifecycle_status ON lens_item
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION active_ai_lens_has_primary();

CREATE CONSTRAINT TRIGGER active_ai_lens_evidence_insert_primary_trigger
AFTER INSERT ON lens_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION active_ai_lens_evidence_insert_has_primary();

CREATE CONSTRAINT TRIGGER active_ai_lens_evidence_update_primary_trigger
AFTER UPDATE OF lens_item_id, relation ON lens_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION active_ai_lens_evidence_update_has_primary();

CREATE CONSTRAINT TRIGGER active_ai_lens_evidence_delete_primary_trigger
AFTER DELETE ON lens_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION active_ai_lens_evidence_delete_has_primary();
