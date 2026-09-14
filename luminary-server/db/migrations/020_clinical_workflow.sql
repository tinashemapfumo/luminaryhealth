-- =============================================================================
-- 020 - Remaining clinical workflow
-- =============================================================================

SET search_path = luminary, public;

CREATE TABLE luminary.care_plan (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id    uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id     uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id   uuid REFERENCES luminary.encounter(id),
  name           text        NOT NULL,
  status         text        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','completed','paused','cancelled')),
  goals          jsonb       NOT NULL DEFAULT '[]',
  interventions  jsonb       NOT NULL DEFAULT '[]',
  progress       int         NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  next_review    date,
  created_by     uuid        NOT NULL REFERENCES luminary.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  origin_node    text
);

CREATE INDEX care_plan_patient_idx
  ON luminary.care_plan (practice_id, patient_id, status)
  WHERE deleted_at IS NULL;

CREATE TABLE luminary.referral (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id     uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id      uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id    uuid REFERENCES luminary.encounter(id),
  referred_to     text        NOT NULL,
  specialty       text,
  reason          text        NOT NULL,
  urgency         text        NOT NULL DEFAULT 'routine'
                    CHECK (urgency IN ('routine','urgent','emergency')),
  status          text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','accepted','completed','cancelled')),
  notes           text,
  created_by      uuid        NOT NULL REFERENCES luminary.app_user(id),
  sent_at         timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  origin_node     text
);

CREATE INDEX referral_patient_idx
  ON luminary.referral (practice_id, patient_id, status)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.care_plan');
SELECT luminary.make_tenant_table('luminary.referral');
