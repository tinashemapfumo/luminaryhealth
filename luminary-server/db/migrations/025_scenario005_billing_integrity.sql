-- =============================================================================
-- 025 · Scenario 005 billing integrity remediation
-- =============================================================================
--
-- Financial writes must fail before persistence when a referenced patient,
-- invoice, service, order, encounter, tariff, or payment is outside the current
-- practice. RLS hiding the row later is not sufficient for money.

SET search_path = luminary, public;

ALTER TABLE luminary.invoice_line
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES luminary.encounter(id);

ALTER TABLE luminary.invoice_line
  DROP CONSTRAINT IF EXISTS invoice_line_origin_check,
  ADD CONSTRAINT invoice_line_origin_check
    CHECK (origin IN ('manual', 'clinical'));

ALTER TABLE luminary.payment
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE luminary.invoice
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_idempotency_key_idx
  ON luminary.invoice (practice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_idempotency_key_idx
  ON luminary.payment (practice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS invoice_line_encounter_idx
  ON luminary.invoice_line (practice_id, encounter_id)
  WHERE encounter_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.guard_invoice_patient_practice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_patient_practice uuid;
BEGIN
  SELECT practice_id INTO v_patient_practice
    FROM luminary.patient
   WHERE id = NEW.patient_id AND deleted_at IS NULL;

  IF v_patient_practice IS NULL OR v_patient_practice <> NEW.practice_id THEN
    RAISE EXCEPTION 'Patient not found'
      USING ERRCODE = '23503', CONSTRAINT = 'invoice_patient_same_practice';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoice_patient_practice_guard ON luminary.invoice;
CREATE TRIGGER invoice_patient_practice_guard
BEFORE INSERT OR UPDATE OF patient_id, practice_id ON luminary.invoice
FOR EACH ROW EXECUTE FUNCTION luminary.guard_invoice_patient_practice();

CREATE OR REPLACE FUNCTION luminary.guard_invoice_line_references()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_invoice record;
  v_ref record;
BEGIN
  SELECT practice_id, patient_id INTO v_invoice
    FROM luminary.invoice
   WHERE id = NEW.invoice_id AND deleted_at IS NULL;

  IF v_invoice.practice_id IS NULL OR v_invoice.practice_id <> NEW.practice_id THEN
    RAISE EXCEPTION 'Invoice not found'
      USING ERRCODE = '23503', CONSTRAINT = 'invoice_line_invoice_same_practice';
  END IF;

  IF NEW.service_id IS NOT NULL THEN
    SELECT practice_id INTO v_ref FROM luminary.service WHERE id = NEW.service_id AND deleted_at IS NULL;
    IF v_ref.practice_id IS NULL OR v_ref.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Service not found'
        USING ERRCODE = '23503', CONSTRAINT = 'invoice_line_service_same_practice';
    END IF;
  END IF;

  IF NEW.order_id IS NOT NULL THEN
    SELECT practice_id, patient_id, service_id, encounter_id INTO v_ref
      FROM luminary.clinical_order
     WHERE id = NEW.order_id AND deleted_at IS NULL;
    IF v_ref.practice_id IS NULL OR v_ref.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Order not found'
        USING ERRCODE = '23503', CONSTRAINT = 'invoice_line_order_same_practice';
    END IF;
    IF v_ref.patient_id <> v_invoice.patient_id THEN
      RAISE EXCEPTION 'Order does not belong to this invoice patient'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_line_order_patient_match';
    END IF;
    IF NEW.service_id IS NOT NULL AND v_ref.service_id <> NEW.service_id THEN
      RAISE EXCEPTION 'Order service does not match invoice line service'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_line_order_service_match';
    END IF;
    IF NEW.encounter_id IS NOT NULL AND v_ref.encounter_id IS NOT NULL AND v_ref.encounter_id <> NEW.encounter_id THEN
      RAISE EXCEPTION 'Order encounter does not match invoice line encounter'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_line_order_encounter_match';
    END IF;
  END IF;

  IF NEW.encounter_id IS NOT NULL THEN
    SELECT practice_id, patient_id INTO v_ref
      FROM luminary.encounter
     WHERE id = NEW.encounter_id AND deleted_at IS NULL;
    IF v_ref.practice_id IS NULL OR v_ref.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Encounter not found'
        USING ERRCODE = '23503', CONSTRAINT = 'invoice_line_encounter_same_practice';
    END IF;
    IF v_ref.patient_id <> v_invoice.patient_id THEN
      RAISE EXCEPTION 'Encounter does not belong to this invoice patient'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_line_encounter_patient_match';
    END IF;
  END IF;

  IF NEW.tariff_id IS NOT NULL THEN
    SELECT practice_id, service_id INTO v_ref FROM luminary.tariff WHERE id = NEW.tariff_id AND deleted_at IS NULL;
    IF v_ref.practice_id IS NULL OR v_ref.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Tariff not found'
        USING ERRCODE = '23503', CONSTRAINT = 'invoice_line_tariff_same_practice';
    END IF;
    IF NEW.service_id IS NOT NULL AND v_ref.service_id <> NEW.service_id THEN
      RAISE EXCEPTION 'Tariff service does not match invoice line service'
        USING ERRCODE = '23514', CONSTRAINT = 'invoice_line_tariff_service_match';
    END IF;
  END IF;

  IF NEW.origin = 'clinical' AND NEW.service_id IS NULL AND NEW.order_id IS NULL AND NEW.encounter_id IS NULL THEN
    RAISE EXCEPTION 'Clinical invoice lines require clinical provenance'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_line_clinical_provenance';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoice_line_reference_guard ON luminary.invoice_line;
CREATE TRIGGER invoice_line_reference_guard
BEFORE INSERT OR UPDATE OF invoice_id, practice_id, service_id, order_id, encounter_id, tariff_id, origin
ON luminary.invoice_line
FOR EACH ROW EXECUTE FUNCTION luminary.guard_invoice_line_references();

CREATE OR REPLACE FUNCTION luminary.guard_payment_invoice_practice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_invoice_practice uuid;
BEGIN
  SELECT practice_id INTO v_invoice_practice
    FROM luminary.invoice
   WHERE id = NEW.invoice_id AND deleted_at IS NULL;

  IF v_invoice_practice IS NULL OR v_invoice_practice <> NEW.practice_id THEN
    RAISE EXCEPTION 'Invoice not found'
      USING ERRCODE = '23503', CONSTRAINT = 'payment_invoice_same_practice';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payment_invoice_practice_guard ON luminary.payment;
CREATE TRIGGER payment_invoice_practice_guard
BEFORE INSERT OR UPDATE OF invoice_id, practice_id ON luminary.payment
FOR EACH ROW EXECUTE FUNCTION luminary.guard_payment_invoice_practice();

DROP TRIGGER IF EXISTS invoice_adjustment_invoice_practice_guard ON luminary.invoice_adjustment;
CREATE TRIGGER invoice_adjustment_invoice_practice_guard
BEFORE INSERT OR UPDATE OF invoice_id, practice_id ON luminary.invoice_adjustment
FOR EACH ROW EXECUTE FUNCTION luminary.guard_payment_invoice_practice();
