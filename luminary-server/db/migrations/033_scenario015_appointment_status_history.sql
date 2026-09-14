-- =============================================================================
-- 033 . Scenario 015 appointment status history
-- =============================================================================
-- Status history is append-only and trigger-maintained so every API path that
-- creates or advances a visit leaves the same operational trace.

SET search_path = luminary, public;

CREATE TABLE IF NOT EXISTS luminary.appointment_status_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id    uuid        NOT NULL REFERENCES luminary.practice(id),
  appointment_id uuid        NOT NULL REFERENCES luminary.appointment(id),
  from_status    text,
  to_status      text        NOT NULL CHECK (to_status IN (
    'booked',
    'checked_in',
    'in_triage',
    'waiting_for_provider',
    'in_consultation',
    'completed',
    'no_show',
    'cancelled'
  )),
  reason         text,
  changed_by     uuid REFERENCES luminary.app_user(id),
  changed_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  origin_node    text
);

CREATE INDEX IF NOT EXISTS appointment_status_history_appointment_idx
  ON luminary.appointment_status_history (practice_id, appointment_id, changed_at)
  WHERE deleted_at IS NULL;

INSERT INTO luminary.appointment_status_history
  (practice_id, appointment_id, from_status, to_status, reason, changed_at)
SELECT practice_id, id, NULL, status, status_reason, COALESCE(created_at, now())
  FROM luminary.appointment a
 WHERE deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM luminary.appointment_status_history h
      WHERE h.practice_id = a.practice_id
        AND h.appointment_id = a.id
        AND h.from_status IS NULL
        AND h.to_status = a.status
   );

CREATE OR REPLACE FUNCTION luminary.tg_appointment_status_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO luminary.appointment_status_history
      (practice_id, appointment_id, from_status, to_status, reason, changed_by)
    VALUES
      (NEW.practice_id, NEW.id, NULL, NEW.status, NEW.status_reason, luminary.current_user_id());
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO luminary.appointment_status_history
      (practice_id, appointment_id, from_status, to_status, reason, changed_by)
    VALUES
      (NEW.practice_id, NEW.id, OLD.status, NEW.status, NEW.status_reason, luminary.current_user_id());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointment_status_history
  ON luminary.appointment;

CREATE TRIGGER appointment_status_history
AFTER INSERT OR UPDATE OF status ON luminary.appointment
FOR EACH ROW
EXECUTE FUNCTION luminary.tg_appointment_status_history();

SELECT luminary.make_tenant_table('luminary.appointment_status_history');
