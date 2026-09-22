-- =============================================================================
-- 043 - Controlled patient file exports
-- =============================================================================

SET search_path = luminary, public;

CREATE TABLE luminary.patient_export_job (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id       uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id        uuid        NOT NULL REFERENCES luminary.patient(id),
  requested_by      uuid        NOT NULL REFERENCES luminary.app_user(id),
  purpose           text        NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 3 AND 240),
  included_sections text[]      NOT NULL,
  date_from         date,
  date_to           date,
  status            text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'expired', 'revoked')),
  storage_key       text,
  checksum          text,
  size_bytes        bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  failure_code      text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  downloaded_at     timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  origin_node       text,
  CONSTRAINT patient_export_dates_ordered CHECK (
    date_from IS NULL OR date_to IS NULL OR date_to >= date_from
  ),
  CONSTRAINT patient_export_sections_known CHECK (
    cardinality(included_sections) > 0
    AND included_sections <@ ARRAY['summary','clinical','appointments','billing','documents']::text[]
  ),
  CONSTRAINT patient_export_ready_has_file CHECK (
    status <> 'ready' OR (storage_key IS NOT NULL AND checksum IS NOT NULL AND size_bytes IS NOT NULL)
  )
);

CREATE INDEX patient_export_job_queue_idx
  ON luminary.patient_export_job (status, requested_at)
  WHERE deleted_at IS NULL AND status = 'pending';

CREATE INDEX patient_export_job_patient_idx
  ON luminary.patient_export_job (practice_id, patient_id, requested_at DESC)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.patient_export_job');

CREATE OR REPLACE FUNCTION luminary.claim_next_patient_export(p_node text)
RETURNS TABLE (id uuid, practice_id uuid)
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
  RETURNING j.id, j.practice_id;
END
$$;

CREATE OR REPLACE FUNCTION luminary.expired_patient_export_files()
RETURNS TABLE (id uuid, practice_id uuid, storage_key text)
LANGUAGE sql SECURITY DEFINER
SET search_path = luminary, public
AS $$
  SELECT j.id, j.practice_id, j.storage_key
    FROM luminary.patient_export_job j
   WHERE j.deleted_at IS NULL
     AND j.status = 'ready'
     AND j.expires_at <= now()
     AND j.storage_key IS NOT NULL
$$;

REVOKE ALL ON FUNCTION luminary.claim_next_patient_export(text) FROM public;
REVOKE ALL ON FUNCTION luminary.expired_patient_export_files() FROM public;
GRANT EXECUTE ON FUNCTION luminary.claim_next_patient_export(text) TO luminary_app;
GRANT EXECUTE ON FUNCTION luminary.expired_patient_export_files() TO luminary_app;
