-- =============================================================================
-- 037 · Doctor dictation drafts
-- =============================================================================

SET search_path = luminary, public;

CREATE TABLE luminary.encounter_dictation (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id              uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id               uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id             uuid        NOT NULL REFERENCES luminary.encounter(id),
  created_by               uuid        NOT NULL REFERENCES luminary.app_user(id),
  status                   text        NOT NULL DEFAULT 'captured'
                              CHECK (status IN ('captured','structured','note_approved','prescription_approved','discarded','failed')),
  stt_provider             text        NOT NULL DEFAULT 'manual',
  stt_model                text,
  clinical_ai_provider     text        NOT NULL DEFAULT 'mock',
  clinical_ai_model        text,
  raw_transcript           text        NOT NULL CHECK (length(trim(raw_transcript)) > 0),
  structured_draft         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  approved_note_fields     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  approved_prescription_id uuid REFERENCES luminary.prescription(id),
  approved_by              uuid REFERENCES luminary.app_user(id),
  approved_at              timestamptz,
  error_code               text,
  error_message            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  origin_node              text,
  CONSTRAINT encounter_dictation_approval_consistent CHECK (
    (approved_at IS NULL AND approved_by IS NULL)
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  )
);

CREATE INDEX encounter_dictation_encounter_idx
  ON luminary.encounter_dictation (practice_id, encounter_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX encounter_dictation_patient_idx
  ON luminary.encounter_dictation (practice_id, patient_id, created_at DESC)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.encounter_dictation');

CREATE OR REPLACE FUNCTION luminary.enforce_encounter_dictation_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_patient uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.created_by, 'Dictating clinician');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.approved_by, 'Approving clinician');
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
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id, created_by, approved_by, approved_prescription_id
ON luminary.encounter_dictation
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_encounter_dictation_refs();
