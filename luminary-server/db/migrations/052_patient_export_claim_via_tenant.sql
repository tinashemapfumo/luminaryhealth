-- =============================================================================
-- 052 - Claim patient exports through a real tenant context, not a bypass
-- =============================================================================
--
-- 051 fixed queue *visibility* for luminary_migrator but tried to also let it
-- perform the claiming UPDATE cross-tenant. That still failed: every tenant
-- table's touch_and_log trigger inserts into luminary.sync_change, which is
-- itself forced-RLS with only the standard tenant_isolation policy, and
-- luminary_migrator has no practice context to satisfy it either. Bypassing
-- writes table-by-table down the trigger chain is the wrong shape of fix.
--
-- The correct shape, already used by the messaging dispatcher and sync
-- worker: cross the tenant boundary only to discover which row/practice has
-- work, then perform the actual write inside a normal withTenant() call for
-- that practice, where current_practice_id() is genuinely set and every
-- existing RLS policy and trigger just works. No further bypass needed.

SET search_path = luminary, public;

DROP FUNCTION IF EXISTS luminary.claim_next_patient_export(text);

DROP POLICY IF EXISTS patient_export_queue_claim ON luminary.patient_export_job;

CREATE FUNCTION luminary.next_pending_patient_export()
RETURNS TABLE (id uuid, practice_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = luminary, public
AS $$
  SELECT id, practice_id
    FROM luminary.patient_export_job
   WHERE status = 'pending' AND deleted_at IS NULL
   ORDER BY requested_at
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION luminary.next_pending_patient_export() FROM public;
GRANT EXECUTE ON FUNCTION luminary.next_pending_patient_export() TO luminary_app;
