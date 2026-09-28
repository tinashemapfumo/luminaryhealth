-- =============================================================================
-- 059 - Distinguish encounter-note and prescription dictation pipelines
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.encounter_dictation
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'encounter_note';

ALTER TABLE luminary.encounter_dictation
  ADD CONSTRAINT encounter_dictation_purpose_check
    CHECK (purpose IN ('encounter_note', 'prescription'));

CREATE INDEX IF NOT EXISTS encounter_dictation_purpose_idx
  ON luminary.encounter_dictation (practice_id, purpose, created_at DESC)
  WHERE deleted_at IS NULL;
