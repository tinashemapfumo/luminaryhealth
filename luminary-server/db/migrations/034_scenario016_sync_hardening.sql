-- =============================================================================
-- 034 . Scenario 016 sync hardening
-- =============================================================================
-- A sync peer that is wedged on the same structural failure must report that
-- state through the supported status endpoint, not only through process logs.

SET search_path = luminary, public;

ALTER TABLE luminary.sync_peer
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;

COMMENT ON COLUMN luminary.sync_peer.last_error IS
  'Most recent sync-cycle failure for this peer. Cleared by a successful cycle.';
COMMENT ON COLUMN luminary.sync_peer.consecutive_failures IS
  'Consecutive failed sync cycles since the last successful cycle.';

-- Later feature migrations introduced new foreign keys after migration 008.
-- Re-run the same safe conversion so replication can defer all practice-local
-- dependency checks until a whole batch/page has landed.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass::text AS tbl,
           conname,
           pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype = 'f'
       AND connamespace = 'luminary'::regnamespace
       AND NOT condeferrable
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s DEFERRABLE INITIALLY IMMEDIATE',
                   r.tbl, r.conname, r.def);
  END LOOP;
END
$$;
