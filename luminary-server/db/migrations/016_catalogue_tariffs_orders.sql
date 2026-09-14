-- =============================================================================
-- 016 · Service catalogue, payer tariffs, clinical orders, imports
-- =============================================================================
--
-- Brings the schema up to the model the workspace has been running against:
-- what the practice does and charges (catalogue), what each scheme reimburses
-- (tariffs), what a clinician asked for (orders), and where imported pricing
-- came from (batches).
--
-- The rule running through all of it is that **a price is not a number, it is a
-- number with a period attached**. Both the practice's own price and a payer's
-- rate are effective-dated, and nothing is ever overwritten — an invoice raised
-- in August has to keep resolving August's figures however many times the
-- practice re-prices afterwards, or the books cannot explain themselves.

SET search_path = luminary, public;

-- -----------------------------------------------------------------------------
-- Service catalogue
-- -----------------------------------------------------------------------------
CREATE TABLE luminary.service (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id          uuid        NOT NULL REFERENCES luminary.practice(id),
  internal_code        text        NOT NULL,
  display_name         text        NOT NULL,
  clinical_name        text        NOT NULL,
  billing_description  text        NOT NULL,
  category             text        NOT NULL DEFAULT 'Consultation',
  department           text        NOT NULL DEFAULT 'General Practice',
  service_type         text        NOT NULL DEFAULT 'service',
  default_duration     int         NOT NULL DEFAULT 15,
  default_quantity     int         NOT NULL DEFAULT 1 CHECK (default_quantity > 0),
  billable             boolean     NOT NULL DEFAULT true,
  -- Only the triggers something can actually emit. A value here that no part of
  -- the system can ever fire is configuration that silently does nothing.
  billing_trigger      text        NOT NULL DEFAULT 'ON_COMPLETION'
                                   CHECK (billing_trigger IN ('ON_ORDER', 'ON_COMPLETION', 'MANUAL')),
  default_tariff_code  text,
  notes                text        NOT NULL DEFAULT '',
  active               boolean     NOT NULL DEFAULT true,
  import_batch_id      uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  origin_node          text,
  UNIQUE (practice_id, internal_code)
);

-- The practice's own price, as dated periods. Re-pricing closes the current
-- period and opens a new one; it never edits what a past invoice was raised at.
CREATE TABLE luminary.service_price (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id    uuid          NOT NULL REFERENCES luminary.practice(id),
  service_id     uuid          NOT NULL REFERENCES luminary.service(id),
  amount         numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency       text          NOT NULL DEFAULT 'USD',
  effective_from date          NOT NULL,
  effective_to   date,
  created_by     uuid REFERENCES luminary.app_user(id),
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  origin_node    text,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- External descriptions that resolve to one service. What makes import
-- matching deterministic instead of a guess.
CREATE TABLE luminary.service_alias (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid        NOT NULL REFERENCES luminary.practice(id),
  service_id  uuid        NOT NULL REFERENCES luminary.service(id),
  alias       text        NOT NULL CHECK (length(btrim(alias)) > 0),
  source      text        NOT NULL DEFAULT 'import',
  payer_id    uuid,
  approved_by uuid REFERENCES luminary.app_user(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text,
  UNIQUE (practice_id, service_id, alias)
);

-- Which visit type is normally billed under which service. Data, because a
-- practice must be able to change it without a deployment.
CREATE TABLE luminary.service_visit_type (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid        NOT NULL REFERENCES luminary.practice(id),
  service_id  uuid        NOT NULL REFERENCES luminary.service(id),
  visit_type  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text,
  UNIQUE (practice_id, visit_type)
);

-- -----------------------------------------------------------------------------
-- Payers, plans and tariffs
-- -----------------------------------------------------------------------------
CREATE TABLE luminary.payer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid        NOT NULL REFERENCES luminary.practice(id),
  name        text        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text,
  UNIQUE (practice_id, name)
);

-- A plan already exists. `luminary.scheme` has carried a name and a
-- reimbursement percentage since migration 002, and `patient.scheme_id` points
-- at it. A second plan table here would have created two competing notions of
-- the same thing and left the tariff resolver guessing which one a patient's
-- cover meant. So a scheme gains a payer instead of being replaced.
ALTER TABLE luminary.scheme
  ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES luminary.payer(id);

COMMENT ON COLUMN luminary.scheme.payer_id IS
  'The medical aid this plan belongs to. Null for a plan configured before payers existed, which still prices by its own reimburse_percent.';

CREATE TABLE luminary.tariff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id     uuid          NOT NULL REFERENCES luminary.practice(id),
  payer_id        uuid          NOT NULL REFERENCES luminary.payer(id),
  -- Null means the schedule did not distinguish plans, which is common: it
  -- becomes a payer-wide rate that any plan-specific row outranks.
  plan_id         uuid REFERENCES luminary.scheme(id),
  service_id      uuid          NOT NULL REFERENCES luminary.service(id),
  code            text          NOT NULL,
  description     text          NOT NULL DEFAULT '',
  rate            numeric(12,2) NOT NULL CHECK (rate >= 0),
  currency        text          NOT NULL DEFAULT 'USD',
  effective_from  date          NOT NULL,
  effective_to    date,
  active          boolean       NOT NULL DEFAULT true,
  source          text,
  import_batch_id uuid,
  -- Set when a later import replaced this row, so the chain of what supplanted
  -- what is recoverable and a rollback knows exactly which periods to reopen.
  superseded_by   uuid REFERENCES luminary.tariff(id),
  rolled_back_at  timestamptz,
  created_by      uuid REFERENCES luminary.app_user(id),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  origin_node     text,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX tariff_resolution_idx
  ON luminary.tariff (practice_id, service_id, payer_id, effective_from)
  WHERE deleted_at IS NULL AND active;

-- -----------------------------------------------------------------------------
-- Clinical orders
-- -----------------------------------------------------------------------------
--
-- An order is what a clinician decided should happen. It is deliberately not a
-- billing record: billing on the *order* charges people for tests that were
-- cancelled, declined, or never performed.
CREATE TABLE luminary.clinical_order (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id         uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id          uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id        uuid REFERENCES luminary.encounter(id),
  service_id          uuid        NOT NULL REFERENCES luminary.service(id),
  quantity            int         NOT NULL DEFAULT 1 CHECK (quantity > 0),
  priority            text        NOT NULL DEFAULT 'Routine'
                                  CHECK (priority IN ('Routine', 'Urgent', 'Stat')),
  status              text        NOT NULL DEFAULT 'Ordered'
                                  CHECK (status IN ('Ordered', 'Accepted', 'In progress',
                                                    'Completed', 'Cancelled', 'Declined')),
  clinical_notes      text        NOT NULL DEFAULT '',
  ordered_by          uuid        NOT NULL REFERENCES luminary.app_user(id),
  ordered_at          timestamptz NOT NULL DEFAULT now(),
  completed_by        uuid REFERENCES luminary.app_user(id),
  completed_at        timestamptz,
  cancellation_reason text,
  invoice_id          uuid REFERENCES luminary.invoice(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  origin_node         text,
  -- Work that did not happen must say why. Enforced here rather than in the
  -- service so a direct write cannot skip the explanation.
  CHECK (status NOT IN ('Cancelled', 'Declined')
         OR length(btrim(coalesce(cancellation_reason, ''))) >= 5)
);

CREATE INDEX clinical_order_queue_idx
  ON luminary.clinical_order (practice_id, status)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- Invoice lines: the funder model, and idempotent billing
-- -----------------------------------------------------------------------------
--
-- `scheme_pays` used to be one number meaning "what we think the scheme will
-- pay" right up until the scheme paid something different, at which point it
-- meant nothing at all. That is what let a rejected claim sit on the books as
-- revenue that was never going to arrive. Estimated and actual are now separate
-- and neither overwrites the other.
ALTER TABLE luminary.invoice_line
  ADD COLUMN IF NOT EXISTS service_id              uuid REFERENCES luminary.service(id),
  ADD COLUMN IF NOT EXISTS estimated_funder        numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_funder_approved  numeric(12,2),
  ADD COLUMN IF NOT EXISTS actual_funder_paid      numeric(12,2),
  ADD COLUMN IF NOT EXISTS tariff_id               uuid REFERENCES luminary.tariff(id),
  ADD COLUMN IF NOT EXISTS tariff_via              text,
  ADD COLUMN IF NOT EXISTS order_id                uuid REFERENCES luminary.clinical_order(id),
  ADD COLUMN IF NOT EXISTS billing_key             text;

COMMENT ON COLUMN luminary.invoice_line.estimated_funder IS
  'What the tariff said when the line was raised. Never overwritten by adjudication.';
COMMENT ON COLUMN luminary.invoice_line.tariff_via IS
  'Which rule priced this line — plan tariff, payer tariff, plan percentage, no cover.';

-- The idempotency guarantee. A completion event can arrive more than once — a
-- double click, a retry, a replay after a reload — and each arrival must not
-- add another charge. Partial, because manually raised lines carry no key.
CREATE UNIQUE INDEX invoice_line_billing_key_idx
  ON luminary.invoice_line (practice_id, billing_key)
  WHERE billing_key IS NOT NULL AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- Import batches
-- -----------------------------------------------------------------------------
CREATE TABLE luminary.import_batch (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id    uuid        NOT NULL REFERENCES luminary.practice(id),
  kind           text        NOT NULL CHECK (kind IN ('tariff', 'service')),
  filename       text        NOT NULL,
  checksum       text,
  payer_id       uuid REFERENCES luminary.payer(id),
  mapping        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  row_count      int         NOT NULL DEFAULT 0,
  valid_count    int         NOT NULL DEFAULT 0,
  warning_count  int         NOT NULL DEFAULT 0,
  error_count    int         NOT NULL DEFAULT 0,
  published_count int        NOT NULL DEFAULT 0,
  status         text        NOT NULL DEFAULT 'UPLOADED'
                             CHECK (status IN ('UPLOADED', 'VALIDATING', 'REVIEW_REQUIRED',
                                               'READY', 'PUBLISHED', 'FAILED', 'ROLLED_BACK')),
  imported_by    uuid        NOT NULL REFERENCES luminary.app_user(id),
  imported_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  origin_node    text
);

-- Uploaded rows land here and nowhere near live pricing until published. A
-- mis-mapped column applied straight to production would silently re-price a
-- whole practice, and the first person to notice would be a patient at the desk.
CREATE TABLE luminary.import_row (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  batch_id     uuid        NOT NULL REFERENCES luminary.import_batch(id),
  line_number  int         NOT NULL,
  raw          jsonb       NOT NULL,
  resolved     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status       text        NOT NULL CHECK (status IN ('VALID', 'WARNING', 'ERROR')),
  issues       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  matched_via  text,
  resolved_by  uuid REFERENCES luminary.app_user(id),
  ignored      boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text,
  UNIQUE (batch_id, line_number)
);

CREATE TABLE luminary.mapping_profile (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id      uuid        NOT NULL REFERENCES luminary.practice(id),
  name             text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('tariff', 'service')),
  payer_id         uuid REFERENCES luminary.payer(id),
  mapping          jsonb       NOT NULL,
  header_signature text        NOT NULL,
  created_by       uuid        NOT NULL REFERENCES luminary.app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  origin_node      text,
  UNIQUE (practice_id, kind, payer_id, header_signature)
);

-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------
SELECT luminary.make_tenant_table('luminary.service');
SELECT luminary.make_tenant_table('luminary.service_price');
SELECT luminary.make_tenant_table('luminary.service_alias');
SELECT luminary.make_tenant_table('luminary.service_visit_type');
SELECT luminary.make_tenant_table('luminary.payer');
SELECT luminary.make_tenant_table('luminary.tariff');
SELECT luminary.make_tenant_table('luminary.clinical_order');
SELECT luminary.make_tenant_table('luminary.import_batch');
SELECT luminary.make_tenant_table('luminary.import_row');
SELECT luminary.make_tenant_table('luminary.mapping_profile');
