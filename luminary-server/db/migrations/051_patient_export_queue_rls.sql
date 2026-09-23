-- =============================================================================
-- 051 - Fix patient export queue: forced RLS silently blocked the claimer
-- =============================================================================
--
-- `claim_next_patient_export()` and `patient_export_files_to_remove()`
-- (migrations 043/044) are SECURITY DEFINER and owned by luminary_migrator —
-- a non-superuser role. The background worker deliberately calls them
-- through `withoutTenant()`, since one worker process claims queued exports
-- across every practice from a single connection, the same way the
-- messaging dispatcher and sync worker already do.
--
-- What was missing: `patient_export_job` has FORCE ROW LEVEL SECURITY
-- (migration 043, via `make_tenant_table`), and luminary_migrator was never
-- given a policy for it. With no practice context set, `current_practice_id()`
-- is null, the tenant_isolation policy (`practice_id = current_practice_id()`)
-- matches nothing, and the claim function silently finds zero pending rows —
-- every export request sits at 'pending' forever, the background worker never
-- logs an error because there is nothing to fail, and the browser's 2-minute
-- poll just times out. Confirmed live: two real export requests never left
-- 'pending' with `started_at` still null.
--
-- Fix mirrors the one already used for invitation lookups in 046: a narrow
-- SELECT+UPDATE bypass for luminary_migrator, scoped to this table only,
-- rather than weakening the tenant boundary luminary_app operates under.

SET search_path = luminary, public;

DROP POLICY IF EXISTS patient_export_queue_lookup ON luminary.patient_export_job;
CREATE POLICY patient_export_queue_lookup ON luminary.patient_export_job
  FOR SELECT
  TO luminary_migrator
  USING (true);

DROP POLICY IF EXISTS patient_export_queue_claim ON luminary.patient_export_job;
CREATE POLICY patient_export_queue_claim ON luminary.patient_export_job
  FOR UPDATE
  TO luminary_migrator
  USING (true)
  WITH CHECK (true);
