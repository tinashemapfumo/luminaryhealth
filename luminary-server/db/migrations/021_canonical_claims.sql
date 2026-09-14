-- =============================================================================
-- 021 - Canonical claims, adjudication, transmissions, and switch readiness
-- =============================================================================
--
-- Luminary owns the claim model. NH263/New Health 263 is a switch adapter, not
-- the shape of the database. This migration keeps the existing invoice-created
-- claim rows and extends them into a submission record with immutable snapshots,
-- line-level adjudication, event history, and attachment references.

SET search_path = luminary, public;

ALTER TABLE luminary.practice_settings
  ADD COLUMN IF NOT EXISTS nh263_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nh263_environment text NOT NULL DEFAULT 'pending'
    CHECK (nh263_environment IN ('pending', 'sandbox', 'test', 'production')),
  ADD COLUMN IF NOT EXISTS nh263_organisation_identifier text,
  ADD COLUMN IF NOT EXISTS nh263_secret_ref text,
  ADD COLUMN IF NOT EXISTS claims_status_poll_minutes int NOT NULL DEFAULT 0
    CHECK (claims_status_poll_minutes >= 0),
  ADD COLUMN IF NOT EXISTS claims_capabilities text[] NOT NULL DEFAULT ARRAY['manual','email_pdf']::text[],
  ADD COLUMN IF NOT EXISTS claims_last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS claims_integration_health text NOT NULL DEFAULT 'not_configured'
    CHECK (claims_integration_health IN ('not_configured','healthy','degraded','failing'));

ALTER TABLE luminary.app_user
  ADD COLUMN IF NOT EXISTS provider_identifiers jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE luminary.patient
  ADD COLUMN IF NOT EXISTS member_suffix text,
  ADD COLUMN IF NOT EXISTS relationship_to_member text,
  ADD COLUMN IF NOT EXISTS cover_effective_from date,
  ADD COLUMN IF NOT EXISTS cover_external_ref text,
  ADD COLUMN IF NOT EXISTS cover_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS cover_verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (cover_verification_status IN ('unverified','verified','failed','expired','manual'));

ALTER TABLE luminary.claim
  RENAME COLUMN reference TO claim_number;

ALTER TABLE luminary.claim
  ALTER COLUMN invoice_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES luminary.encounter(id),
  ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES luminary.payer(id),
  ADD COLUMN IF NOT EXISTS membership_number text,
  ADD COLUMN IF NOT EXISTS member_suffix text,
  ADD COLUMN IF NOT EXISTS member_name text,
  ADD COLUMN IF NOT EXISTS relationship_to_member text,
  ADD COLUMN IF NOT EXISTS service_from_date date,
  ADD COLUMN IF NOT EXISTS service_to_date date,
  ADD COLUMN IF NOT EXISTS claim_type text NOT NULL DEFAULT 'medical_aid',
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS total_claimed_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_approved_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_rejected_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS member_liability numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurer_liability numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submission_channel text NOT NULL DEFAULT 'MANUAL'
    CHECK (submission_channel IN ('NH263','EMAIL_PDF','MANUAL')),
  ADD COLUMN IF NOT EXISTS external_reference text,
  ADD COLUMN IF NOT EXISTS switch_reference text,
  ADD COLUMN IF NOT EXISTS external_status text,
  ADD COLUMN IF NOT EXISTS funder_status text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS submission_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS validation_result jsonb NOT NULL DEFAULT '{"valid":false,"errors":[],"warnings":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE luminary.claim
   SET membership_number = COALESCE(membership_number, member_number),
       switch_reference = COALESCE(switch_reference, switch_ref),
       submission_channel = CASE WHEN switch_ref IS NOT NULL THEN 'NH263' ELSE submission_channel END;

ALTER TABLE luminary.claim
  DROP CONSTRAINT IF EXISTS claim_status_check;

ALTER TABLE luminary.claim
  ALTER COLUMN status SET DEFAULT 'DRAFT';

ALTER TABLE luminary.claim
  ADD CONSTRAINT claim_status_check CHECK (status IN (
    'DRAFT','READY','VALIDATION_FAILED','READY_FOR_SUBMISSION','SUBMITTING',
    'SUBMITTED','ACKNOWLEDGED','PROCESSING','APPROVED','PARTIALLY_APPROVED',
    'REJECTED','QUERY','REQUIRES_ACTION','CANCELLED','FAILED',
    'draft','biometric_verified','submitted','adjudicated','remitted','rejected'
  ));

UPDATE luminary.claim
   SET status = CASE status
     WHEN 'draft' THEN 'DRAFT'
     WHEN 'biometric_verified' THEN 'READY_FOR_SUBMISSION'
     WHEN 'submitted' THEN 'SUBMITTED'
     WHEN 'adjudicated' THEN 'APPROVED'
     WHEN 'remitted' THEN 'APPROVED'
     WHEN 'rejected' THEN 'REJECTED'
     ELSE status
   END;

CREATE INDEX IF NOT EXISTS claim_patient_idx
  ON luminary.claim (practice_id, patient_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS claim_status_idx
  ON luminary.claim (practice_id, status, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS claim_payer_idx
  ON luminary.claim (practice_id, payer_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS claim_invoice_idx
  ON luminary.claim (practice_id, invoice_id)
  WHERE invoice_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS claim_external_reference_idx
  ON luminary.claim (practice_id, external_reference)
  WHERE external_reference IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS claim_idempotency_idx
  ON luminary.claim (practice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE luminary.claim_line (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id                     uuid          NOT NULL REFERENCES luminary.practice(id),
  claim_id                        uuid          NOT NULL REFERENCES luminary.claim(id),
  invoice_line_id                 uuid REFERENCES luminary.invoice_line(id),
  service_id                      uuid REFERENCES luminary.service(id),
  line_number                     int           NOT NULL DEFAULT 1,
  tariff_code                     text,
  tariff_description              text          NOT NULL DEFAULT '',
  quantity                        numeric(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price                      numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  claimed_amount                  numeric(12,2) NOT NULL DEFAULT 0 CHECK (claimed_amount >= 0),
  approved_amount                 numeric(12,2) NOT NULL DEFAULT 0 CHECK (approved_amount >= 0),
  rejected_amount                 numeric(12,2) NOT NULL DEFAULT 0 CHECK (rejected_amount >= 0),
  member_liability                numeric(12,2) NOT NULL DEFAULT 0 CHECK (member_liability >= 0),
  insurer_liability               numeric(12,2) NOT NULL DEFAULT 0 CHECK (insurer_liability >= 0),
  service_date                    date,
  practitioner_id                 uuid REFERENCES luminary.app_user(id),
  referring_provider_id           uuid REFERENCES luminary.app_user(id),
  service_location                text,
  status                          text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','READY','SUBMITTED','APPROVED','PARTIALLY_APPROVED','REJECTED','QUERY','REQUIRES_ACTION','FAILED')),
  adjudication_reason_code        text,
  adjudication_reason_description text,
  external_line_reference         text,
  metadata                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  deleted_at                      timestamptz,
  origin_node                     text,
  UNIQUE (practice_id, claim_id, line_number)
);

CREATE TABLE luminary.claim_diagnosis (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  claim_id     uuid        NOT NULL REFERENCES luminary.claim(id),
  claim_line_id uuid REFERENCES luminary.claim_line(id),
  code         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  kind         text        NOT NULL DEFAULT 'secondary' CHECK (kind IN ('primary','secondary')),
  sequence     int         NOT NULL DEFAULT 1,
  source       text        NOT NULL DEFAULT 'encounter',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

CREATE TABLE luminary.claim_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id       uuid        NOT NULL REFERENCES luminary.practice(id),
  claim_id          uuid        NOT NULL REFERENCES luminary.claim(id),
  event_type        text        NOT NULL,
  actor_id          uuid REFERENCES luminary.app_user(id),
  actor_kind        text        NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','system','integration')),
  previous_status   text,
  new_status        text,
  external_reference text,
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  origin_node       text
);

CREATE INDEX IF NOT EXISTS claim_event_claim_idx
  ON luminary.claim_event (practice_id, claim_id, occurred_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE luminary.claim_transmission (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id        uuid        NOT NULL REFERENCES luminary.practice(id),
  claim_id           uuid        NOT NULL REFERENCES luminary.claim(id),
  adapter            text        NOT NULL,
  direction          text        NOT NULL CHECK (direction IN ('outbound','inbound')),
  attempt_number     int         NOT NULL DEFAULT 1,
  request_reference  text,
  external_reference text,
  sent_at            timestamptz,
  received_at        timestamptz,
  status             text        NOT NULL CHECK (status IN ('queued','sent','received','succeeded','failed','pending')),
  normalized_result  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  raw_payload_ref    text,
  error_code         text,
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  origin_node        text
);

CREATE INDEX IF NOT EXISTS claim_transmission_claim_idx
  ON luminary.claim_transmission (practice_id, claim_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE luminary.claim_adjudication (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id       uuid          NOT NULL REFERENCES luminary.practice(id),
  claim_id          uuid          NOT NULL REFERENCES luminary.claim(id),
  payer_reference   text,
  adjudicated_at    timestamptz,
  claimed_amount    numeric(12,2) NOT NULL DEFAULT 0,
  approved_amount   numeric(12,2) NOT NULL DEFAULT 0,
  rejected_amount   numeric(12,2) NOT NULL DEFAULT 0,
  member_liability  numeric(12,2) NOT NULL DEFAULT 0,
  insurer_liability numeric(12,2) NOT NULL DEFAULT 0,
  result            text          NOT NULL CHECK (result IN ('APPROVED','PARTIALLY_APPROVED','REJECTED','QUERY')),
  notes             text,
  raw_payload_ref   text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  origin_node       text
);

CREATE TABLE luminary.claim_attachment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  claim_id     uuid        NOT NULL REFERENCES luminary.claim(id),
  document_id  uuid        NOT NULL REFERENCES luminary.patient_document(id),
  attachment_type text     NOT NULL CHECK (attachment_type IN (
    'prescription','laboratory_request','radiology_request','referral',
    'hospital_breakdown','discharge_document','clinical_support','other'
  )),
  reason       text        NOT NULL,
  added_by     uuid        NOT NULL REFERENCES luminary.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text,
  UNIQUE (practice_id, claim_id, document_id)
);

CREATE TABLE luminary.claim_remittance (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id           uuid          NOT NULL REFERENCES luminary.practice(id),
  payer_id              uuid REFERENCES luminary.payer(id),
  remittance_reference  text          NOT NULL,
  payment_date          date,
  payment_amount        numeric(12,2) NOT NULL DEFAULT 0,
  currency              text          NOT NULL DEFAULT 'USD',
  details               jsonb         NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_status text          NOT NULL DEFAULT 'unmatched'
    CHECK (reconciliation_status IN ('unmatched','matched','partially_matched','reconciled','exception')),
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  origin_node           text,
  UNIQUE (practice_id, remittance_reference)
);

CREATE TABLE luminary.claim_eligibility_result (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id            uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id             uuid        NOT NULL REFERENCES luminary.patient(id),
  payer_id               uuid REFERENCES luminary.payer(id),
  scheme_id              uuid REFERENCES luminary.scheme(id),
  verification_method    text        NOT NULL DEFAULT 'manual',
  membership_valid       boolean,
  eligible               boolean,
  member_status          text,
  plan_name              text,
  verification_reference text,
  response_timestamp     timestamptz,
  messages               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  origin_node            text
);

CREATE TABLE luminary.claim_authorisation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id        uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id         uuid        NOT NULL REFERENCES luminary.patient(id),
  claim_id           uuid REFERENCES luminary.claim(id),
  service_id         uuid REFERENCES luminary.service(id),
  payer_id           uuid REFERENCES luminary.payer(id),
  diagnosis_code     text,
  status             text        NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','REQUESTED','APPROVED','DECLINED','EXPIRED','CANCELLED')),
  external_reference text,
  approval_number    text,
  expires_on         date,
  approved_limits    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  created_by         uuid REFERENCES luminary.app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  origin_node        text
);

SELECT luminary.make_tenant_table('luminary.claim_line');
SELECT luminary.make_tenant_table('luminary.claim_diagnosis');
SELECT luminary.make_tenant_table('luminary.claim_event');
SELECT luminary.make_tenant_table('luminary.claim_transmission');
SELECT luminary.make_tenant_table('luminary.claim_adjudication');
SELECT luminary.make_tenant_table('luminary.claim_attachment');
SELECT luminary.make_tenant_table('luminary.claim_remittance');
SELECT luminary.make_tenant_table('luminary.claim_eligibility_result');
SELECT luminary.make_tenant_table('luminary.claim_authorisation');
