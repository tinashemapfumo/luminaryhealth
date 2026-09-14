-- =============================================================================
-- 004 · Scheduling, clinical records, billing, claims
-- =============================================================================

SET search_path = luminary, public;

-- -----------------------------------------------------------------------------
-- Scheduling
-- -----------------------------------------------------------------------------
CREATE TABLE luminary.appointment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id   uuid        NOT NULL REFERENCES luminary.patient(id),
  provider_id  uuid        NOT NULL REFERENCES luminary.app_user(id),
  room_id      uuid REFERENCES luminary.room(id),
  starts_at    timestamptz NOT NULL,
  duration_min int         NOT NULL DEFAULT 30 CHECK (duration_min > 0),
  visit_type   text,
  mode         text        NOT NULL DEFAULT 'in_person',
  status       text        NOT NULL DEFAULT 'booked'
                 CHECK (status IN ('booked','checked_in','in_consultation','completed','no_show','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

CREATE INDEX appointment_day_idx ON luminary.appointment (practice_id, starts_at) WHERE deleted_at IS NULL;

-- A provider or a room cannot hold two overlapping visits. Expressed as an
-- exclusion constraint so the database refuses it, rather than relying on the
-- application to check first — under sync, two nodes will genuinely try.
-- `ends_at` is a stored column rather than part of the generated expression.
-- PostgreSQL requires a generated expression to be IMMUTABLE, and
-- `timestamptz + interval` is only STABLE: adding days or months depends on the
-- session TimeZone across DST boundaries, so the original one-line version
-- would have been rejected at migration time. tstzrange() over two plain
-- timestamps is immutable, so the range generates cleanly from there.
ALTER TABLE luminary.appointment ADD COLUMN ends_at timestamptz;

CREATE OR REPLACE FUNCTION luminary.tg_appointment_ends_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.ends_at := NEW.starts_at + make_interval(mins => NEW.duration_min);
  RETURN NEW;
END
$$;

CREATE TRIGGER appointment_ends_at
  BEFORE INSERT OR UPDATE OF starts_at, duration_min ON luminary.appointment
  FOR EACH ROW EXECUTE FUNCTION luminary.tg_appointment_ends_at();

ALTER TABLE luminary.appointment
  ADD COLUMN period tstzrange
  GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED;

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_provider_no_overlap
  EXCLUDE USING gist (provider_id WITH =, period WITH &&)
  WHERE (deleted_at IS NULL AND status <> 'cancelled');

ALTER TABLE luminary.appointment
  ADD CONSTRAINT appointment_room_no_overlap
  EXCLUDE USING gist (room_id WITH =, period WITH &&)
  WHERE (deleted_at IS NULL AND status <> 'cancelled' AND room_id IS NOT NULL);

-- -----------------------------------------------------------------------------
-- Clinical records
-- -----------------------------------------------------------------------------
-- Signing is a one-way legal act. Once signed the SOAP body is frozen and
-- corrections must be appended as addenda, because an audited record has to
-- show what was written and when — not a silently rewritten version.
CREATE TABLE luminary.encounter (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id    uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id     uuid        NOT NULL REFERENCES luminary.patient(id),
  appointment_id uuid REFERENCES luminary.appointment(id),
  author_id      uuid        NOT NULL REFERENCES luminary.app_user(id),
  note_type      text        NOT NULL DEFAULT 'SOAP note',
  status         text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','amended')),

  vitals         jsonb       NOT NULL DEFAULT '{}',
  vitals_by      uuid REFERENCES luminary.app_user(id),
  subjective     text,
  objective      text,
  assessment     text,
  plan           text,
  diagnoses      jsonb       NOT NULL DEFAULT '[]',
  follow_up      text,

  signed_by      uuid REFERENCES luminary.app_user(id),
  signed_at      timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  origin_node    text,

  -- A signed note must carry a signature; an unsigned one must not.
  CONSTRAINT signature_consistent CHECK (
    (status = 'draft'  AND signed_by IS NULL AND signed_at IS NULL) OR
    (status <> 'draft' AND signed_by IS NOT NULL AND signed_at IS NOT NULL)
  )
);

CREATE INDEX encounter_patient_idx ON luminary.encounter (practice_id, patient_id) WHERE deleted_at IS NULL;

-- Immutability enforced in the database, not merely in the service layer.
CREATE OR REPLACE FUNCTION luminary.tg_encounter_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.subjective IS DISTINCT FROM OLD.subjective
       OR NEW.objective IS DISTINCT FROM OLD.objective
       OR NEW.assessment IS DISTINCT FROM OLD.assessment
       OR NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.vitals IS DISTINCT FROM OLD.vitals
       OR NEW.diagnoses IS DISTINCT FROM OLD.diagnoses THEN
      RAISE EXCEPTION 'encounter % is signed; record a correction as an addendum', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER encounter_immutable
  BEFORE UPDATE ON luminary.encounter
  FOR EACH ROW EXECUTE FUNCTION luminary.tg_encounter_immutable();

CREATE TABLE luminary.encounter_addendum (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  encounter_id uuid        NOT NULL REFERENCES luminary.encounter(id),
  body         text        NOT NULL,
  author_id    uuid        NOT NULL REFERENCES luminary.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

CREATE TABLE luminary.prescription (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id   uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id    uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id  uuid REFERENCES luminary.encounter(id),
  prescriber_id uuid        NOT NULL REFERENCES luminary.app_user(id),
  drug          text        NOT NULL,
  strength      text,
  route         text,
  frequency     text,
  duration_days int,
  refills       int         NOT NULL DEFAULT 0,
  pharmacy      text,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  origin_node   text
);

CREATE TABLE luminary.lab_result (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id   uuid        NOT NULL REFERENCES luminary.patient(id),
  test_name    text        NOT NULL,
  value        text,
  unit         text,
  normal_range text,
  abnormal     boolean     NOT NULL DEFAULT false,
  resulted_on  date,
  reviewed_by  uuid REFERENCES luminary.app_user(id),
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

-- -----------------------------------------------------------------------------
-- Billing and claims
-- -----------------------------------------------------------------------------
CREATE TABLE luminary.invoice (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id         uuid          NOT NULL REFERENCES luminary.practice(id),
  patient_id          uuid          NOT NULL REFERENCES luminary.patient(id),
  reference           text          NOT NULL,
  issued_on           date          NOT NULL DEFAULT current_date,
  due_on              date,
  currency            text          NOT NULL DEFAULT 'ZWL',
  total               numeric(12,2) NOT NULL DEFAULT 0,
  scheme_portion      numeric(12,2) NOT NULL DEFAULT 0,
  patient_portion     numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid         numeric(12,2) NOT NULL DEFAULT 0,
  status              text          NOT NULL DEFAULT 'pending',
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  origin_node         text,
  UNIQUE (practice_id, reference)
);

CREATE TABLE luminary.invoice_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid          NOT NULL REFERENCES luminary.practice(id),
  invoice_id  uuid          NOT NULL REFERENCES luminary.invoice(id),
  tariff_code text          NOT NULL,
  description text          NOT NULL,
  quantity    int           NOT NULL DEFAULT 1,
  unit_price  numeric(12,2) NOT NULL,
  scheme_pays numeric(12,2) NOT NULL DEFAULT 0,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text
);

-- Payments are append-only: a receipt is never edited, it is reversed by a
-- second entry. Money that can be quietly rewritten is money nobody can audit.
CREATE TABLE luminary.payment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid          NOT NULL REFERENCES luminary.practice(id),
  invoice_id   uuid          NOT NULL REFERENCES luminary.invoice(id),
  amount       numeric(12,2) NOT NULL,
  currency     text          NOT NULL DEFAULT 'ZWL',
  fx_rate      numeric(12,4),
  method       text          NOT NULL,        -- cash, ecocash, card, transfer
  received_by  uuid          NOT NULL REFERENCES luminary.app_user(id),
  received_at  timestamptz   NOT NULL DEFAULT now(),
  reverses_id  uuid REFERENCES luminary.payment(id),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

CREATE TABLE luminary.claim (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id    uuid        NOT NULL REFERENCES luminary.practice(id),
  invoice_id     uuid        NOT NULL REFERENCES luminary.invoice(id),
  patient_id     uuid        NOT NULL REFERENCES luminary.patient(id),
  reference      text        NOT NULL,
  scheme_id      uuid REFERENCES luminary.scheme(id),
  member_number  text,
  status         text        NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','biometric_verified','submitted','adjudicated','remitted','rejected')),
  biometric_at   timestamptz,
  biometric_ref  text,
  submitted_at   timestamptz,
  switch_ref     text,
  -- Every response from the NH263 switch, appended in order.
  responses      jsonb       NOT NULL DEFAULT '[]',
  rejection_code text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  origin_node    text,
  UNIQUE (practice_id, reference)
);

CREATE TABLE luminary.message (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id   uuid REFERENCES luminary.patient(id),
  channel      text        NOT NULL,
  template     text,
  body         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'queued',
  sent_by      uuid REFERENCES luminary.app_user(id),
  queued_at    timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

-- Defined here rather than with the patient table: it reads appointment and
-- encounter, so its dependencies must exist first.
-- Does this user have standing grounds to see this patient? Mirrors
-- `careRelationship()` in the client, but this is the copy that counts.
-- Returns the reason, or NULL when only break-glass would let them through.
CREATE OR REPLACE FUNCTION luminary.care_relationship(p_user uuid, p_patient uuid)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_role text;
  v_name text;
  v_result text;
BEGIN
  SELECT role, display_name INTO v_role, v_name
    FROM luminary.app_user WHERE id = p_user AND active AND deleted_at IS NULL;
  IF v_role IS NULL THEN RETURN NULL; END IF;

  -- Nurses, reception, and managers work across the whole practice by design:
  -- a nurse serves every doctor and reception books for all of them.
  IF v_role <> 'doctor' THEN RETURN 'practice staff'; END IF;

  IF EXISTS (SELECT 1 FROM luminary.patient
              WHERE id = p_patient AND primary_provider_id = p_user AND deleted_at IS NULL)
  THEN RETURN 'primary provider'; END IF;

  SELECT kind INTO v_result FROM luminary.access_grant
    WHERE user_id = p_user AND patient_id = p_patient
      AND deleted_at IS NULL AND now() BETWEEN valid_from AND valid_until
    ORDER BY valid_until DESC LIMIT 1;
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;

  IF EXISTS (SELECT 1 FROM luminary.appointment
              WHERE patient_id = p_patient AND provider_id = p_user AND deleted_at IS NULL)
  THEN RETURN 'booked with you'; END IF;

  IF EXISTS (SELECT 1 FROM luminary.encounter
              WHERE patient_id = p_patient AND author_id = p_user AND deleted_at IS NULL)
  THEN RETURN 'authored a note'; END IF;

  RETURN NULL;
END
$$;

SELECT luminary.make_tenant_table('luminary.appointment');
SELECT luminary.make_tenant_table('luminary.encounter');
SELECT luminary.make_tenant_table('luminary.encounter_addendum');
SELECT luminary.make_tenant_table('luminary.prescription');
SELECT luminary.make_tenant_table('luminary.lab_result');
SELECT luminary.make_tenant_table('luminary.invoice');
SELECT luminary.make_tenant_table('luminary.invoice_line');
SELECT luminary.make_tenant_table('luminary.payment');
SELECT luminary.make_tenant_table('luminary.claim');
SELECT luminary.make_tenant_table('luminary.message');
