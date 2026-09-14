-- =============================================================================
-- 026 - Scenario 006 claim cover readiness
-- =============================================================================
--
-- Scenario 006 needs live payer/scheme setup and patient cover to be dependable
-- enough for invoice-derived claims. The columns already exist; this migration
-- adds the integrity that keeps configuration repeatable.

SET search_path = luminary, public;

CREATE UNIQUE INDEX IF NOT EXISTS payer_live_name_idx
  ON luminary.payer (practice_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS scheme_live_payer_name_idx
  ON luminary.scheme (practice_id, payer_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS scheme_live_payer_name_exact_idx
  ON luminary.scheme (practice_id, payer_id, name)
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'patient_cover_dates_order_check'
       AND conrelid = 'luminary.patient'::regclass
  ) THEN
    ALTER TABLE luminary.patient
      ADD CONSTRAINT patient_cover_dates_order_check
      CHECK (cover_effective_from IS NULL OR cover_valid_until IS NULL OR cover_valid_until >= cover_effective_from);
  END IF;
END $$;
