-- =============================================================================
-- 032 . Scenario 015 front-desk and encounter integrity
-- =============================================================================
-- Appointment/encounter links must stay mechanically true even if a future API
-- path forgets to validate them. The trigger below is a database backstop; the
-- application still performs friendly validation first.

SET search_path = luminary, public;

ALTER TABLE luminary.appointment
  ADD COLUMN IF NOT EXISTS status_reason text;

CREATE INDEX IF NOT EXISTS appointment_operational_time_idx
  ON luminary.appointment (practice_id, COALESCE(starts_at, arrived_at, created_at))
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.guard_encounter_patient_appointment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_patient_practice uuid;
  v_patient_merged_into uuid;
  v_appointment_practice uuid;
  v_appointment_patient uuid;
BEGIN
  SELECT practice_id, merged_into_id
    INTO v_patient_practice, v_patient_merged_into
    FROM luminary.patient
   WHERE id = NEW.patient_id
     AND deleted_at IS NULL;

  IF v_patient_practice IS NULL OR v_patient_practice <> NEW.practice_id THEN
    RAISE EXCEPTION 'Encounter patient is not in this practice'
      USING ERRCODE = '23503',
            CONSTRAINT = 'encounter_patient_same_practice';
  END IF;

  IF v_patient_merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'Encounter patient has been merged into %', v_patient_merged_into
      USING ERRCODE = '23514',
            CONSTRAINT = 'encounter_patient_canonical';
  END IF;

  IF NEW.appointment_id IS NOT NULL THEN
    SELECT practice_id, patient_id
      INTO v_appointment_practice, v_appointment_patient
      FROM luminary.appointment
     WHERE id = NEW.appointment_id
       AND deleted_at IS NULL;

    IF v_appointment_practice IS NULL OR v_appointment_practice <> NEW.practice_id THEN
      RAISE EXCEPTION 'Encounter appointment is not in this practice'
        USING ERRCODE = '23503',
              CONSTRAINT = 'encounter_appointment_same_practice';
    END IF;

    IF v_appointment_patient <> NEW.patient_id THEN
      RAISE EXCEPTION 'Encounter appointment belongs to a different patient'
        USING ERRCODE = '23514',
              CONSTRAINT = 'encounter_appointment_patient_match';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS encounter_patient_appointment_guard
  ON luminary.encounter;

CREATE TRIGGER encounter_patient_appointment_guard
BEFORE INSERT OR UPDATE OF practice_id, patient_id, appointment_id
ON luminary.encounter
FOR EACH ROW
EXECUTE FUNCTION luminary.guard_encounter_patient_appointment();
