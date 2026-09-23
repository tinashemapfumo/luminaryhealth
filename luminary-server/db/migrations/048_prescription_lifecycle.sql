-- =============================================================================
-- 048 - Prescription lifecycle, correction provenance, and idempotent issue
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.prescription
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by        uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS completed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_at       timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by       uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS supersedes_id       uuid REFERENCES luminary.prescription(id),
  ADD COLUMN IF NOT EXISTS idempotency_key     text;

-- Historical data predates explicit lifecycle timestamps. Preserve it and make
-- the lifecycle truthful instead of pretending those events happened now.
UPDATE luminary.prescription
   SET completed_at = COALESCE(completed_at, updated_at, created_at)
 WHERE status = 'completed'
   AND completed_at IS NULL;

UPDATE luminary.prescription
   SET cancelled_at = COALESCE(cancelled_at, updated_at, created_at),
       cancelled_by = COALESCE(cancelled_by, prescriber_id),
       cancellation_reason = COALESCE(NULLIF(btrim(cancellation_reason), ''), 'Cancelled before lifecycle tracking')
 WHERE status = 'cancelled';

UPDATE luminary.prescription
   SET superseded_at = COALESCE(superseded_at, updated_at, created_at),
       superseded_by = COALESCE(superseded_by, prescriber_id)
 WHERE status = 'superseded';

ALTER TABLE luminary.prescription
  ADD CONSTRAINT prescription_status_valid
    CHECK (status IN ('draft', 'active', 'completed', 'cancelled', 'expired', 'superseded')),
  ADD CONSTRAINT prescription_cancellation_complete
    CHECK (
      (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
                            AND NULLIF(btrim(cancellation_reason), '') IS NOT NULL)
      OR
      (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by IS NULL
                             AND cancellation_reason IS NULL)
    ),
  ADD CONSTRAINT prescription_completion_complete
    CHECK ((status = 'completed' AND completed_at IS NOT NULL)
           OR (status <> 'completed' AND completed_at IS NULL)),
  ADD CONSTRAINT prescription_supersession_complete
    CHECK ((status = 'superseded' AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL)
           OR (status <> 'superseded' AND superseded_at IS NULL AND superseded_by IS NULL)),
  ADD CONSTRAINT prescription_not_self_superseding
    CHECK (supersedes_id IS NULL OR supersedes_id <> id);

ALTER TABLE luminary.prescription
  ADD CONSTRAINT prescription_practice_idempotency_unique
    UNIQUE (practice_id, idempotency_key);

CREATE INDEX prescription_patient_history_idx
  ON luminary.prescription (practice_id, patient_id, issued_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.enforce_prescription_lifecycle_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior_patient uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.prescriber_id, 'Prescriber');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.cancelled_by, 'Cancelling user');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.superseded_by, 'Superseding user');

  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT patient_id INTO prior_patient
      FROM luminary.prescription
     WHERE id = NEW.supersedes_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF prior_patient IS NULL THEN
      RAISE EXCEPTION 'Superseded prescription is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF prior_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Replacement prescription must belong to the same patient' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER enforce_prescription_lifecycle_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, prescriber_id, cancelled_by, superseded_by, supersedes_id
ON luminary.prescription
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_prescription_lifecycle_refs();
