-- =============================================================================
-- 027 - Scenario 009 receivables, remittance, and payment provenance
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.payment
  ADD COLUMN IF NOT EXISTS responsibility_bucket text NOT NULL DEFAULT 'patient',
  ADD COLUMN IF NOT EXISTS claim_id uuid REFERENCES luminary.claim(id),
  ADD COLUMN IF NOT EXISTS remittance_id uuid REFERENCES luminary.claim_remittance(id),
  ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES luminary.payer(id),
  ADD COLUMN IF NOT EXISTS payment_reference text;

ALTER TABLE luminary.payment
  DROP CONSTRAINT IF EXISTS payment_responsibility_bucket_check,
  ADD CONSTRAINT payment_responsibility_bucket_check
    CHECK (responsibility_bucket IN ('patient','insurer'));

CREATE UNIQUE INDEX IF NOT EXISTS payment_reference_idx
  ON luminary.payment (practice_id, payment_reference)
  WHERE payment_reference IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_claim_idx
  ON luminary.payment (practice_id, claim_id)
  WHERE claim_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_remittance_idx
  ON luminary.payment (practice_id, remittance_id)
  WHERE remittance_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE luminary.claim_remittance
  ADD COLUMN IF NOT EXISTS claim_id uuid REFERENCES luminary.claim(id),
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES luminary.app_user(id);

CREATE INDEX IF NOT EXISTS claim_remittance_claim_idx
  ON luminary.claim_remittance (practice_id, claim_id)
  WHERE claim_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE luminary.invoice_adjustment
  ADD COLUMN IF NOT EXISTS responsibility_bucket text NOT NULL DEFAULT 'patient',
  ADD COLUMN IF NOT EXISTS claim_id uuid REFERENCES luminary.claim(id),
  ADD COLUMN IF NOT EXISTS claim_line_id uuid REFERENCES luminary.claim_line(id);

ALTER TABLE luminary.invoice_adjustment
  DROP CONSTRAINT IF EXISTS invoice_adjustment_responsibility_bucket_check,
  ADD CONSTRAINT invoice_adjustment_responsibility_bucket_check
    CHECK (responsibility_bucket IN ('patient','insurer','denied'));

CREATE TABLE IF NOT EXISTS luminary.claim_denial_disposition (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id       uuid          NOT NULL REFERENCES luminary.practice(id),
  claim_id          uuid          NOT NULL REFERENCES luminary.claim(id),
  claim_line_id     uuid          REFERENCES luminary.claim_line(id),
  invoice_id        uuid          NOT NULL REFERENCES luminary.invoice(id),
  disposition       text          NOT NULL
    CHECK (disposition IN ('PATIENT_RESPONSIBILITY','WRITE_OFF','APPEAL','RESUBMIT')),
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  currency          text          NOT NULL DEFAULT 'USD',
  reason            text          NOT NULL CHECK (length(btrim(reason)) >= 10),
  adjustment_id     uuid          REFERENCES luminary.invoice_adjustment(id),
  decided_by        uuid          NOT NULL REFERENCES luminary.app_user(id),
  decided_at        timestamptz   NOT NULL DEFAULT now(),
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  origin_node       text
);

CREATE INDEX IF NOT EXISTS claim_denial_disposition_claim_idx
  ON luminary.claim_denial_disposition (practice_id, claim_id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.guard_payment_receivable_references()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_invoice record;
  v_claim record;
  v_remittance record;
BEGIN
  SELECT practice_id, patient_id INTO v_invoice
    FROM luminary.invoice
   WHERE id = NEW.invoice_id AND deleted_at IS NULL;

  IF v_invoice.practice_id IS NULL OR v_invoice.practice_id <> NEW.practice_id THEN
    RAISE EXCEPTION 'Invoice not found'
      USING ERRCODE = '23503', CONSTRAINT = 'payment_invoice_same_practice';
  END IF;

  IF NEW.claim_id IS NOT NULL THEN
    SELECT practice_id, patient_id, invoice_id, payer_id INTO v_claim
      FROM luminary.claim
     WHERE id = NEW.claim_id AND deleted_at IS NULL;
    IF v_claim.practice_id IS NULL OR v_claim.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Claim not found'
        USING ERRCODE = '23503', CONSTRAINT = 'payment_claim_same_practice';
    END IF;
    IF v_claim.invoice_id <> NEW.invoice_id OR v_claim.patient_id <> v_invoice.patient_id THEN
      RAISE EXCEPTION 'Claim does not belong to this invoice'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_claim_invoice_match';
    END IF;
    IF NEW.payer_id IS NOT NULL AND v_claim.payer_id IS NOT NULL AND NEW.payer_id <> v_claim.payer_id THEN
      RAISE EXCEPTION 'Payer does not match claim'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_payer_claim_match';
    END IF;
  END IF;

  IF NEW.remittance_id IS NOT NULL THEN
    SELECT practice_id, claim_id, payer_id INTO v_remittance
      FROM luminary.claim_remittance
     WHERE id = NEW.remittance_id AND deleted_at IS NULL;
    IF v_remittance.practice_id IS NULL OR v_remittance.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Remittance not found'
        USING ERRCODE = '23503', CONSTRAINT = 'payment_remittance_same_practice';
    END IF;
    IF NEW.claim_id IS NOT NULL AND v_remittance.claim_id IS NOT NULL AND NEW.claim_id <> v_remittance.claim_id THEN
      RAISE EXCEPTION 'Remittance does not belong to this claim'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_remittance_claim_match';
    END IF;
    IF NEW.payer_id IS NOT NULL AND v_remittance.payer_id IS NOT NULL AND NEW.payer_id <> v_remittance.payer_id THEN
      RAISE EXCEPTION 'Payer does not match remittance'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_payer_remittance_match';
    END IF;
  END IF;

  IF NEW.responsibility_bucket = 'insurer' AND NEW.claim_id IS NULL AND NEW.reverses_id IS NULL THEN
    RAISE EXCEPTION 'Insurer payments require claim provenance'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_insurer_claim_required';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payment_invoice_practice_guard ON luminary.payment;
DROP TRIGGER IF EXISTS payment_receivable_reference_guard ON luminary.payment;
CREATE TRIGGER payment_receivable_reference_guard
BEFORE INSERT OR UPDATE OF invoice_id, practice_id, responsibility_bucket, claim_id, remittance_id, payer_id, reverses_id
ON luminary.payment
FOR EACH ROW EXECUTE FUNCTION luminary.guard_payment_receivable_references();

CREATE OR REPLACE FUNCTION luminary.guard_claim_remittance_references()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_claim record;
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    SELECT practice_id, payer_id INTO v_claim
      FROM luminary.claim
     WHERE id = NEW.claim_id AND deleted_at IS NULL;
    IF v_claim.practice_id IS NULL OR v_claim.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Claim not found'
        USING ERRCODE = '23503', CONSTRAINT = 'claim_remittance_claim_same_practice';
    END IF;
    IF NEW.payer_id IS NOT NULL AND v_claim.payer_id IS NOT NULL AND NEW.payer_id <> v_claim.payer_id THEN
      RAISE EXCEPTION 'Payer does not match claim'
        USING ERRCODE = '23514', CONSTRAINT = 'claim_remittance_payer_claim_match';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS claim_remittance_reference_guard ON luminary.claim_remittance;
CREATE TRIGGER claim_remittance_reference_guard
BEFORE INSERT OR UPDATE OF practice_id, claim_id, payer_id
ON luminary.claim_remittance
FOR EACH ROW EXECUTE FUNCTION luminary.guard_claim_remittance_references();

CREATE OR REPLACE FUNCTION luminary.guard_denial_disposition_references()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_claim record;
  v_line record;
BEGIN
  SELECT practice_id, invoice_id, currency INTO v_claim
    FROM luminary.claim
   WHERE id = NEW.claim_id AND deleted_at IS NULL;
  IF v_claim.practice_id IS NULL OR v_claim.practice_id <> NEW.practice_id THEN
    RAISE EXCEPTION 'Claim not found'
      USING ERRCODE = '23503', CONSTRAINT = 'claim_denial_claim_same_practice';
  END IF;
  IF v_claim.invoice_id <> NEW.invoice_id THEN
    RAISE EXCEPTION 'Invoice does not match claim'
      USING ERRCODE = '23514', CONSTRAINT = 'claim_denial_invoice_match';
  END IF;
  IF NEW.claim_line_id IS NOT NULL THEN
    SELECT practice_id, claim_id INTO v_line
      FROM luminary.claim_line
     WHERE id = NEW.claim_line_id AND deleted_at IS NULL;
    IF v_line.practice_id IS NULL OR v_line.practice_id <> NEW.practice_id OR v_line.claim_id <> NEW.claim_id THEN
      RAISE EXCEPTION 'Claim line not found'
        USING ERRCODE = '23503', CONSTRAINT = 'claim_denial_line_same_claim';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS claim_denial_disposition_reference_guard ON luminary.claim_denial_disposition;
CREATE TRIGGER claim_denial_disposition_reference_guard
BEFORE INSERT OR UPDATE OF practice_id, claim_id, claim_line_id, invoice_id
ON luminary.claim_denial_disposition
FOR EACH ROW EXECUTE FUNCTION luminary.guard_denial_disposition_references();

CREATE OR REPLACE FUNCTION luminary.guard_invoice_adjustment_receivable_references()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_invoice_practice uuid;
  v_claim record;
  v_line record;
BEGIN
  SELECT practice_id INTO v_invoice_practice
    FROM luminary.invoice
   WHERE id = NEW.invoice_id AND deleted_at IS NULL;

  IF v_invoice_practice IS NULL OR v_invoice_practice <> NEW.practice_id THEN
    RAISE EXCEPTION 'Invoice not found'
      USING ERRCODE = '23503', CONSTRAINT = 'invoice_adjustment_invoice_same_practice';
  END IF;

  IF NEW.claim_id IS NOT NULL THEN
    SELECT practice_id, invoice_id INTO v_claim
      FROM luminary.claim
     WHERE id = NEW.claim_id AND deleted_at IS NULL;
    IF v_claim.practice_id IS NULL OR v_claim.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Claim not found'
        USING ERRCODE = '23503', CONSTRAINT = 'invoice_adjustment_claim_same_practice';
    END IF;
    IF v_claim.invoice_id <> NEW.invoice_id THEN
      RAISE EXCEPTION 'Claim does not belong to this invoice'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_adjustment_claim_invoice_match';
    END IF;
  END IF;

  IF NEW.claim_line_id IS NOT NULL THEN
    SELECT practice_id, claim_id INTO v_line
      FROM luminary.claim_line
     WHERE id = NEW.claim_line_id AND deleted_at IS NULL;
    IF v_line.practice_id IS NULL OR v_line.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Claim line not found'
        USING ERRCODE = '23503', CONSTRAINT = 'invoice_adjustment_line_same_practice';
    END IF;
    IF NEW.claim_id IS NOT NULL AND v_line.claim_id <> NEW.claim_id THEN
      RAISE EXCEPTION 'Claim line does not belong to this claim'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_adjustment_line_claim_match';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoice_adjustment_invoice_practice_guard ON luminary.invoice_adjustment;
DROP TRIGGER IF EXISTS invoice_adjustment_receivable_reference_guard ON luminary.invoice_adjustment;
CREATE TRIGGER invoice_adjustment_receivable_reference_guard
BEFORE INSERT OR UPDATE OF invoice_id, practice_id, responsibility_bucket, claim_id, claim_line_id
ON luminary.invoice_adjustment
FOR EACH ROW EXECUTE FUNCTION luminary.guard_invoice_adjustment_receivable_references();

SELECT luminary.make_tenant_table('luminary.claim_denial_disposition');
