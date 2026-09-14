-- =============================================================================
-- 035 · Scenario 017 messaging runtime hardening
-- =============================================================================

SET search_path = luminary, public;

-- Integration authentication needs to identify a credential before tenant
-- context exists. This is intentionally narrow: callers can only resolve the
-- one key id they present, and only the fields needed to authenticate it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'luminary'
       AND tablename = 'integration_credential'
       AND policyname = 'integration_credential_bootstrap_lookup'
  ) THEN
    CREATE POLICY integration_credential_bootstrap_lookup
      ON luminary.integration_credential
      FOR SELECT
      USING (
        deleted_at IS NULL
        AND key_id = NULLIF(current_setting('luminary.integration_key_id', true), '')
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION luminary.lookup_integration_credential(p_key_id text)
RETURNS TABLE (
  id uuid,
  practice_id uuid,
  name text,
  scopes text[],
  secret_hash text,
  active boolean,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = luminary, public
AS $$
BEGIN
  PERFORM set_config('luminary.integration_key_id', p_key_id, true);

  RETURN QUERY
    SELECT c.id, c.practice_id, c.name, c.scopes, c.secret_hash, c.active, c.expires_at
      FROM luminary.integration_credential c
     WHERE c.key_id = p_key_id
       AND c.deleted_at IS NULL;
END
$$;

GRANT EXECUTE ON FUNCTION luminary.lookup_integration_credential(text) TO luminary_app;

ALTER TABLE luminary.message
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES luminary.appointment(id);

CREATE INDEX IF NOT EXISTS message_appointment_idx
  ON luminary.message (practice_id, appointment_id, queued_at)
  WHERE appointment_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.enforce_message_appointment_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  appt record;
BEGIN
  IF NEW.appointment_id IS NOT NULL THEN
    SELECT practice_id, patient_id INTO appt
      FROM luminary.appointment
     WHERE id = NEW.appointment_id
       AND deleted_at IS NULL;

    IF appt.practice_id IS NULL THEN
      RAISE EXCEPTION 'Appointment not found for message'
        USING ERRCODE = '23503';
    END IF;

    IF appt.practice_id IS DISTINCT FROM NEW.practice_id THEN
      RAISE EXCEPTION 'Message appointment belongs to another practice'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.patient_id IS NULL OR appt.patient_id IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Message appointment must belong to the message patient'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_message_appointment_match ON luminary.message;
CREATE TRIGGER enforce_message_appointment_match
BEFORE INSERT OR UPDATE OF practice_id, patient_id, appointment_id
ON luminary.message
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_message_appointment_match();
