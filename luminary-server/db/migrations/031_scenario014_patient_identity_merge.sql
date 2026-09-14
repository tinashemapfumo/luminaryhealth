-- =============================================================================
-- 031 - Scenario 014 patient identity and merge foundation
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.patient
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES luminary.patient(id),
  ADD COLUMN IF NOT EXISTS merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_by uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS merge_reason text;

ALTER TABLE luminary.patient
  DROP CONSTRAINT IF EXISTS patient_not_merged_into_self,
  ADD CONSTRAINT patient_not_merged_into_self
    CHECK (merged_into_id IS NULL OR merged_into_id <> id);

CREATE INDEX IF NOT EXISTS patient_merged_into_idx
  ON luminary.patient (practice_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS luminary.patient_identity_alias (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id       uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id        uuid        NOT NULL REFERENCES luminary.patient(id),
  source_patient_id uuid        REFERENCES luminary.patient(id),
  alias_type        text        NOT NULL CHECK (alias_type IN ('reference','national_id')),
  alias_value       text        NOT NULL,
  normalized_value  text        NOT NULL,
  created_by        uuid        REFERENCES luminary.app_user(id),
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  origin_node       text,
  UNIQUE (practice_id, alias_type, normalized_value)
);

CREATE INDEX IF NOT EXISTS patient_identity_alias_patient_idx
  ON luminary.patient_identity_alias (practice_id, patient_id, alias_type)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.patient_identity_alias');
