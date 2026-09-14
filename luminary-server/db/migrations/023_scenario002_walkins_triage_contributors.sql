-- =============================================================================
-- 023 · Scenario 002 walk-ins, triage readiness, and contributors
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.appointment
  DROP CONSTRAINT IF EXISTS appointment_provider_no_overlap;

ALTER TABLE luminary.appointment
  DROP CONSTRAINT IF EXISTS appointment_room_no_overlap;

ALTER TABLE luminary.appointment
  DROP COLUMN IF EXISTS period;

ALTER TABLE luminary.appointment
  DROP CONSTRAINT IF EXISTS appointment_status_check;

ALTER TABLE luminary.appointment
  DROP CONSTRAINT IF EXISTS appointment_origin_check;

ALTER TABLE luminary.appointment
  DROP CONSTRAINT IF EXISTS appointment_scheduled_requires_slot;

ALTER TABLE luminary.appointment
  DROP CONSTRAINT IF EXISTS appointment_walk_in_arrival_required;

ALTER TABLE luminary.appointment
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_assigned_by uuid REFERENCES luminary.app_user(id) DEFERRABLE INITIALLY IMMEDIATE;

UPDATE luminary.appointment
   SET origin = 'scheduled'
 WHERE origin IS NULL;

ALTER TABLE luminary.appointment
  ALTER COLUMN provider_id DROP NOT NULL,
  ALTER COLUMN starts_at DROP NOT NULL;

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_origin_check
  CHECK (origin IN ('scheduled', 'walk_in'));

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_status_check
  CHECK (status IN (
    'booked',
    'checked_in',
    'in_triage',
    'waiting_for_provider',
    'in_consultation',
    'completed',
    'no_show',
    'cancelled'
  ));

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_scheduled_requires_slot
  CHECK (origin <> 'scheduled' OR (provider_id IS NOT NULL AND starts_at IS NOT NULL));

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_walk_in_arrival_required
  CHECK (origin <> 'walk_in' OR arrived_at IS NOT NULL);

CREATE OR REPLACE FUNCTION luminary.tg_appointment_ends_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.ends_at := CASE
    WHEN NEW.starts_at IS NULL THEN NULL
    ELSE NEW.starts_at + make_interval(mins => NEW.duration_min)
  END;
  RETURN NEW;
END
$$;

UPDATE luminary.appointment
   SET starts_at = starts_at;

ALTER TABLE luminary.appointment
  ADD COLUMN period tstzrange
  GENERATED ALWAYS AS (
    CASE
      WHEN starts_at IS NULL OR ends_at IS NULL THEN NULL
      ELSE tstzrange(starts_at, ends_at, '[)')
    END
  ) STORED;

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_provider_no_overlap
  EXCLUDE USING gist (provider_id WITH =, period WITH &&)
  WHERE (deleted_at IS NULL AND status <> 'cancelled' AND provider_id IS NOT NULL AND period IS NOT NULL);

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_room_no_overlap
  EXCLUDE USING gist (room_id WITH =, period WITH &&)
  WHERE (deleted_at IS NULL AND status <> 'cancelled' AND room_id IS NOT NULL AND period IS NOT NULL);

CREATE INDEX IF NOT EXISTS appointment_origin_status_idx
  ON luminary.appointment (practice_id, origin, status, arrived_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE luminary.encounter
  ADD COLUMN IF NOT EXISTS triage_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS triage_completed_by uuid REFERENCES luminary.app_user(id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE IF NOT EXISTS luminary.encounter_contributor (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id           uuid        NOT NULL REFERENCES luminary.practice(id) DEFERRABLE INITIALLY IMMEDIATE,
  encounter_id          uuid        NOT NULL REFERENCES luminary.encounter(id) DEFERRABLE INITIALLY IMMEDIATE,
  user_id               uuid        NOT NULL REFERENCES luminary.app_user(id) DEFERRABLE INITIALLY IMMEDIATE,
  contribution_type     text        NOT NULL CHECK (contribution_type IN ('triage','vitals','clinical_note','diagnosis','signing')),
  first_contributed_at  timestamptz NOT NULL DEFAULT now(),
  last_contributed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  origin_node           text,
  UNIQUE (practice_id, encounter_id, user_id, contribution_type)
);

CREATE INDEX IF NOT EXISTS encounter_contributor_encounter_idx
  ON luminary.encounter_contributor (practice_id, encounter_id)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.encounter_contributor');
