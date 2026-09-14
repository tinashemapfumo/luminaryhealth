-- =============================================================================
-- 010 · origin_node records the change, not the row's birthplace
-- =============================================================================
--
-- `COALESCE(NEW.origin_node, current_node())` only ever set the column when it
-- was NULL, so it recorded where a row was *first created* and never moved
-- again. That is wrong twice over.
--
-- The damaging half: `collect()` filters `origin_node <> peer` to avoid sending
-- a change back where it came from. With a stale origin, cloud's own edit to a
-- row that had originated at the clinic still carried origin='harare-local', so
-- cloud silently refused to send it back down. The clinic's copy stayed stale
-- forever, with no error anywhere — the worst kind of replication failure,
-- because both sides report success.
--
-- Observed as: cloud last_sent=12 while the local node's last_recv sat at 2.
--
-- Provenance is per-change. A replicated write keeps the sender's value, so the
-- log still shows who authored it; an ordinary write stamps this node.

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

  IF COALESCE(current_setting('luminary.replicating', true), 'off') = 'on' THEN
    -- Keep the sender's origin and timestamp: this change was authored
    -- elsewhere and must not look newer than the copy it came from.
    RETURN NEW;
  END IF;

  -- An ordinary write happened HERE, whatever the row's history.
  NEW.origin_node := luminary.current_node();
  NEW.updated_at  := now();

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
