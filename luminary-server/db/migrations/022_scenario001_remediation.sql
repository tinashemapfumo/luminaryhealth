-- =============================================================================
-- 022 · Scenario 001 remediation
-- =============================================================================

SET search_path = luminary, public;

-- Speed up receptionist lookups by phone and national ID. These remain
-- tenant-scoped through RLS, but the indexes make the intended search behavior
-- cheap enough to use routinely.
CREATE INDEX IF NOT EXISTS patient_phone_digits_lookup_idx
  ON luminary.patient (practice_id, regexp_replace(coalesce(phone, ''), '\D', '', 'g'))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS patient_national_id_lookup_idx
  ON luminary.patient (
    practice_id,
    lower(regexp_replace(coalesce(national_id, ''), '[\s-]', '', 'g'))
  )
  WHERE deleted_at IS NULL;

-- Active patients should not share a national identity inside one practice.
-- Empty IDs are excluded because some walk-in/intake flows may still have to
-- start before identity paperwork is complete.
CREATE UNIQUE INDEX IF NOT EXISTS patient_national_id_unique_active_idx
  ON luminary.patient (
    practice_id,
    lower(regexp_replace(national_id, '[\s-]', '', 'g'))
  )
  WHERE deleted_at IS NULL
    AND nullif(trim(national_id), '') IS NOT NULL;
