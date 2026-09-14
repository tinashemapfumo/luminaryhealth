-- =============================================================================
-- 008 · Deferrable foreign keys, for replication
-- =============================================================================
--
-- A replication batch cannot always be ordered to satisfy foreign keys. Changes
-- arrive in the order they occurred, but an appointment and the patient it
-- refers to may land in different batches, or a row's parent may have been
-- created before the peers ever spoke. Applying them one statement at a time
-- with immediate checks means the first unsatisfied reference aborts the whole
-- transaction — and because the batch is atomic, everything that succeeded
-- rolls back too, so the node retries the same failure forever.
--
-- Making the constraints DEFERRABLE lets the sync transaction check them once,
-- at COMMIT, by which point the whole batch is present. INITIALLY IMMEDIATE
-- keeps ordinary application writes strict: only the sync path opts in, with
-- SET CONSTRAINTS ALL DEFERRED.

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
