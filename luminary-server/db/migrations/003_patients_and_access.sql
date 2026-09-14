-- =============================================================================
-- 003 · Patients, care relationships, access grants
-- =============================================================================

SET search_path = luminary, public;

CREATE TABLE luminary.patient (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id          uuid        NOT NULL REFERENCES luminary.practice(id),
  reference            text        NOT NULL,              -- human-facing, e.g. PT-2048
  full_name            text        NOT NULL,
  preferred_name       text,
  date_of_birth        date,
  sex                  text,
  national_id          text,
  marital_status       text,
  occupation           text,
  language             text,

  phone                text,
  alt_phone            text,
  email                citext,
  address_street       text,
  address_suburb       text,
  address_city         text,
  address_country      text        DEFAULT 'Zimbabwe',
  preferred_contact    text,

  emergency_name       text,
  emergency_relation   text,
  emergency_phone      text,

  scheme_id            uuid REFERENCES luminary.scheme(id),
  member_number        text,
  principal_member     text,
  dependant_code       text,
  cover_valid_until    date,
  cover_status         text,

  blood_type           text,
  -- Distinguishes "no known allergies" from "nobody has asked", which are
  -- clinically very different and must not collapse into one empty list.
  allergies_reviewed   boolean     NOT NULL DEFAULT false,
  allergies            text[]      NOT NULL DEFAULT '{}',
  conditions           text[]      NOT NULL DEFAULT '{}',
  medications          text[]      NOT NULL DEFAULT '{}',
  family_history       text[]      NOT NULL DEFAULT '{}',
  immunisations        text[]      NOT NULL DEFAULT '{}',
  smoking              text,
  alcohol              text,
  exercise             text,
  risk                 text,
  clinical_summary     text,

  consent_treatment    boolean     NOT NULL DEFAULT false,
  consent_comms        boolean     NOT NULL DEFAULT false,
  consent_data_sharing boolean     NOT NULL DEFAULT false,

  primary_provider_id  uuid REFERENCES luminary.app_user(id),
  registered_on        date        NOT NULL DEFAULT current_date,
  balance              numeric(12,2) NOT NULL DEFAULT 0,
  status               text        NOT NULL DEFAULT 'New',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  origin_node          text,
  UNIQUE (practice_id, reference)
);

CREATE INDEX patient_practice_idx  ON luminary.patient (practice_id) WHERE deleted_at IS NULL;
CREATE INDEX patient_provider_idx  ON luminary.patient (practice_id, primary_provider_id) WHERE deleted_at IS NULL;
CREATE INDEX patient_search_idx    ON luminary.patient USING gin (to_tsvector('simple', full_name || ' ' || reference));

-- -----------------------------------------------------------------------------
-- Access grants
-- -----------------------------------------------------------------------------
-- Time-bounded permission for a clinician to see a patient who is not theirs.
-- Ownership cannot express "cover this list for two weeks"; a grant with a
-- reason and an expiry can.
--
-- Break-glass is the same mechanism with a stricter shape: mandatory reason,
-- same-day expiry, and an audit entry the holder cannot suppress. Access
-- control in a clinic is mostly accountability rather than prevention — a
-- system that simply refuses the covering doctor at 2am is one that gets
-- someone hurt.
CREATE TABLE luminary.access_grant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  user_id      uuid        NOT NULL REFERENCES luminary.app_user(id),
  patient_id   uuid        NOT NULL REFERENCES luminary.patient(id),
  kind         text        NOT NULL CHECK (kind IN ('covering', 'referral', 'break_glass')),
  reason       text        NOT NULL,
  granted_by   uuid REFERENCES luminary.app_user(id),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_until  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text,
  CONSTRAINT grant_reason_present CHECK (length(btrim(reason)) >= 10)
);

CREATE INDEX access_grant_live_idx
  ON luminary.access_grant (practice_id, user_id, patient_id)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.patient');
SELECT luminary.make_tenant_table('luminary.access_grant');
