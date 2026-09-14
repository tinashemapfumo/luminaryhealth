-- =============================================================================
-- 028 . Scenario 011 operational reporting foundation
-- =============================================================================
-- Read-only revenue reports need a practice business timezone and payment-ledger
-- indexes. No financial totals are stored here; reports derive from canonical
-- payment rows at query time.

SET search_path = luminary, public;

ALTER TABLE luminary.practice_settings
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Africa/Harare';

UPDATE luminary.practice_settings
   SET timezone = 'Africa/Harare'
 WHERE timezone IS NULL OR btrim(timezone) = '';

CREATE OR REPLACE FUNCTION luminary.guard_practice_settings_timezone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Invalid practice timezone: %', NEW.timezone
      USING ERRCODE = '23514',
            CONSTRAINT = 'practice_settings_timezone_valid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS practice_settings_timezone_valid
  ON luminary.practice_settings;

CREATE TRIGGER practice_settings_timezone_valid
BEFORE INSERT OR UPDATE OF timezone ON luminary.practice_settings
FOR EACH ROW
EXECUTE FUNCTION luminary.guard_practice_settings_timezone();

CREATE INDEX IF NOT EXISTS payment_reporting_period_idx
  ON luminary.payment (practice_id, received_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_reporting_bucket_idx
  ON luminary.payment (practice_id, responsibility_bucket, received_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_reporting_actor_idx
  ON luminary.payment (practice_id, received_by, received_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_reporting_invoice_idx
  ON luminary.payment (practice_id, invoice_id, received_at)
  WHERE deleted_at IS NULL;
