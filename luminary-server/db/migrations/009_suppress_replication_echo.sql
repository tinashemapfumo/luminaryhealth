-- =============================================================================
-- 009 · Suppressing the replication echo
-- =============================================================================
--
-- Applying a peer's change fired the ordinary change-log trigger, so every row
-- received was immediately queued to be sent back. Two consequences, both bad:
--
--   * changes ping-pong between nodes forever, and
--   * the round trip looks like a concurrent edit, so the conflict detector
--     fires on rows nobody actually edited twice. In testing this produced 39
--     "conflicts" out of 96 applied rows, none of them real.
--
-- The fix is a session flag the trigger honours. While `luminary.replicating`
-- is on, rows are written but not logged — they did not originate here, so
-- there is nothing to propagate. Ordinary application writes are untouched.
--
-- `origin_node` is now also preserved from the sender rather than restamped, so
-- provenance survives the hop: the log records where a change was authored, not
-- merely where it last landed.

SET search_path = luminary, public;

CREATE OR REPLACE FUNCTION luminary.tg_touch_and_log() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  op text;
  rec jsonb;
  pid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hard delete is not permitted on %; set deleted_at instead', TG_TABLE_NAME;
  END IF;

  NEW.origin_node := COALESCE(NEW.origin_node, luminary.current_node());

  -- Replicated writes keep the timestamp they arrived with; overwriting it
  -- would make every received row look newer than the peer's copy and defeat
  -- last-write-wins entirely.
  IF COALESCE(current_setting('luminary.replicating', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    op := 'insert';
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    op := 'delete';
  ELSE
    op := 'update';
  END IF;

  rec := to_jsonb(NEW);
  pid := (rec ->> 'practice_id')::uuid;

  INSERT INTO luminary.sync_change (practice_id, table_name, row_id, operation, payload, origin_node)
  VALUES (pid, TG_TABLE_NAME, NEW.id, op, rec, NEW.origin_node);

  RETURN NEW;
END
$$;

-- Conflicts recorded before this fix were artefacts of the echo, not real
-- disagreements. Close them rather than leaving false positives for a human.
UPDATE luminary.sync_conflict
   SET resolved_at = now(), resolution = 'closed: replication echo, not a real conflict'
 WHERE resolved_at IS NULL;
