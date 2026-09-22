-- =============================================================================
-- 044 - Patient export artifact cleanup queue
-- =============================================================================

SET search_path = luminary, public;

DROP FUNCTION luminary.claim_next_patient_export(text);
CREATE FUNCTION luminary.claim_next_patient_export(p_node text)
RETURNS TABLE (id uuid, practice_id uuid, patient_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = luminary, public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id
      FROM luminary.patient_export_job j
     WHERE j.status = 'pending' AND j.deleted_at IS NULL
     ORDER BY j.requested_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE luminary.patient_export_job j
     SET status = 'processing', started_at = now(), updated_at = now(), origin_node = p_node
    FROM candidate c
   WHERE j.id = c.id
  RETURNING j.id, j.practice_id, j.patient_id;
END
$$;

REVOKE ALL ON FUNCTION luminary.claim_next_patient_export(text) FROM public;
GRANT EXECUTE ON FUNCTION luminary.claim_next_patient_export(text) TO luminary_app;

CREATE OR REPLACE FUNCTION luminary.patient_export_files_to_remove()
RETURNS TABLE (id uuid, practice_id uuid, storage_key text, next_status text)
LANGUAGE sql SECURITY DEFINER
SET search_path = luminary, public
AS $$
  SELECT j.id, j.practice_id, j.storage_key,
         CASE WHEN j.status = 'ready' THEN 'expired' ELSE j.status END AS next_status
    FROM luminary.patient_export_job j
   WHERE j.deleted_at IS NULL
     AND j.storage_key IS NOT NULL
     AND ((j.status = 'ready' AND j.expires_at <= now()) OR j.status IN ('revoked','failed'))
$$;

REVOKE ALL ON FUNCTION luminary.patient_export_files_to_remove() FROM public;
GRANT EXECUTE ON FUNCTION luminary.patient_export_files_to_remove() TO luminary_app;
