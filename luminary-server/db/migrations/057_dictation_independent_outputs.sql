-- =============================================================================
-- 057 - A dictation may produce an independently approved note and many
--       prescription lines
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.encounter_dictation
  ADD COLUMN IF NOT EXISTS note_approved_by uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS note_approved_at timestamptz;

ALTER TABLE luminary.prescription
  ADD COLUMN IF NOT EXISTS source_dictation_id uuid REFERENCES luminary.encounter_dictation(id),
  ADD COLUMN IF NOT EXISTS source_medication_index integer;

ALTER TABLE luminary.encounter_dictation
  ADD CONSTRAINT encounter_dictation_note_approval_consistent CHECK (
    (note_approved_at IS NULL AND note_approved_by IS NULL)
    OR (note_approved_at IS NOT NULL AND note_approved_by IS NOT NULL)
  );

ALTER TABLE luminary.prescription
  ADD CONSTRAINT prescription_source_index_nonnegative CHECK (
    source_medication_index IS NULL OR source_medication_index >= 0
  ),
  ADD CONSTRAINT prescription_dictation_source_consistent CHECK (
    (source_dictation_id IS NULL AND source_medication_index IS NULL)
    OR (source_dictation_id IS NOT NULL AND source_medication_index IS NOT NULL)
  );

-- Preserve approvals created under the original single-status model.
UPDATE luminary.encounter_dictation
   SET note_approved_by = approved_by,
       note_approved_at = approved_at
 WHERE status = 'note_approved'
    OR approved_note_fields <> '{}'::jsonb;

UPDATE luminary.prescription p
   SET source_dictation_id = d.id,
       source_medication_index = 0
  FROM luminary.encounter_dictation d
 WHERE d.approved_prescription_id = p.id
   AND p.source_dictation_id IS NULL;

-- Status now describes transcription/structuring only. Note and medication
-- approvals are independent facts represented by their own columns/rows.
ALTER TABLE luminary.encounter_dictation
  DROP CONSTRAINT IF EXISTS encounter_dictation_status_check;

UPDATE luminary.encounter_dictation
   SET status = 'structured'
 WHERE status IN ('note_approved', 'prescription_approved');

ALTER TABLE luminary.encounter_dictation
  ADD CONSTRAINT encounter_dictation_status_check
    CHECK (status IN ('captured', 'structured', 'discarded', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS prescription_dictation_item_unique
  ON luminary.prescription (practice_id, source_dictation_id, source_medication_index)
  WHERE source_dictation_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS prescription_source_dictation_idx
  ON luminary.prescription (practice_id, source_dictation_id)
  WHERE source_dictation_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.enforce_prescription_dictation_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_patient uuid;
  source_encounter uuid;
BEGIN
  IF NEW.source_dictation_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT patient_id, encounter_id
    INTO source_patient, source_encounter
    FROM luminary.encounter_dictation
   WHERE id = NEW.source_dictation_id
     AND practice_id = luminary.current_practice_id()
     AND deleted_at IS NULL;

  IF source_patient IS NULL THEN
    RAISE EXCEPTION 'Source dictation is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF source_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Source dictation belongs to another patient' USING ERRCODE = '23514';
  END IF;
  IF NEW.encounter_id IS DISTINCT FROM source_encounter THEN
    RAISE EXCEPTION 'Prescription encounter does not match source dictation' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER enforce_prescription_dictation_source
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id, source_dictation_id, source_medication_index
ON luminary.prescription
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_prescription_dictation_source();

CREATE OR REPLACE FUNCTION luminary.enforce_encounter_dictation_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_patient uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.created_by, 'Dictating clinician');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.approved_by, 'Approving clinician');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.note_approved_by, 'Note-approving clinician');
  PERFORM luminary.require_same_practice('luminary.prescription', NEW.approved_prescription_id, 'Approved prescription');

  SELECT patient_id INTO encounter_patient
    FROM luminary.encounter
   WHERE id = NEW.encounter_id
     AND practice_id = luminary.current_practice_id()
     AND deleted_at IS NULL;
  IF encounter_patient IS NULL THEN
    RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF encounter_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Dictation encounter must belong to the dictation patient' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_encounter_dictation_refs ON luminary.encounter_dictation;
CREATE TRIGGER enforce_encounter_dictation_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id, created_by, approved_by,
  note_approved_by, approved_prescription_id
ON luminary.encounter_dictation
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_encounter_dictation_refs();
