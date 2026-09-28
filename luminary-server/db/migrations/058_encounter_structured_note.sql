-- =============================================================================
-- 058 - Persist the reviewed clinical structure beneath the SOAP narrative
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.encounter
  ADD COLUMN IF NOT EXISTS structured_note jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE luminary.encounter
  ADD CONSTRAINT encounter_structured_note_object CHECK (jsonb_typeof(structured_note) = 'object');

-- Structured clinical content and follow-up are part of the signed record and
-- must obey the same addendum-only correction rule as the SOAP body.
CREATE OR REPLACE FUNCTION luminary.tg_encounter_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.subjective IS DISTINCT FROM OLD.subjective
       OR NEW.objective IS DISTINCT FROM OLD.objective
       OR NEW.assessment IS DISTINCT FROM OLD.assessment
       OR NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.follow_up IS DISTINCT FROM OLD.follow_up
       OR NEW.structured_note IS DISTINCT FROM OLD.structured_note
       OR NEW.vitals IS DISTINCT FROM OLD.vitals
       OR NEW.diagnoses IS DISTINCT FROM OLD.diagnoses THEN
      RAISE EXCEPTION 'encounter % is signed; record a correction as an addendum', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
