-- =============================================================================
-- 036 · Scenario 018 tenant reference hardening
-- =============================================================================

SET search_path = luminary, public;

GRANT SELECT ON public.schema_migration TO luminary_app;

-- Sync infrastructure is tenant-owned operational data. It deliberately does
-- not use make_tenant_table(), because sync_change must not log itself.
ALTER TABLE luminary.sync_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE luminary.sync_change FORCE ROW LEVEL SECURITY;
ALTER TABLE luminary.sync_peer ENABLE ROW LEVEL SECURITY;
ALTER TABLE luminary.sync_peer FORCE ROW LEVEL SECURITY;
ALTER TABLE luminary.sync_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE luminary.sync_conflict FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'luminary' AND tablename = 'sync_change' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON luminary.sync_change
      USING (practice_id = luminary.current_practice_id())
      WITH CHECK (practice_id = luminary.current_practice_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'luminary' AND tablename = 'sync_peer' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON luminary.sync_peer
      USING (practice_id = luminary.current_practice_id())
      WITH CHECK (practice_id = luminary.current_practice_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'luminary' AND tablename = 'sync_conflict' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON luminary.sync_conflict
      USING (practice_id = luminary.current_practice_id())
      WITH CHECK (practice_id = luminary.current_practice_id());
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION luminary.require_same_practice(p_table regclass, p_id uuid, p_label text)
RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE
  found boolean;
BEGIN
  IF p_id IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1 AND practice_id = luminary.current_practice_id() AND deleted_at IS NULL)',
    p_table
  )
  INTO found
  USING p_id;

  IF NOT found THEN
    RAISE EXCEPTION '% is not in this practice', p_label USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION luminary.enforce_appointment_tenant_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.provider_id, 'Provider');
  PERFORM luminary.require_same_practice('luminary.room', NEW.room_id, 'Room');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_appointment_tenant_refs ON luminary.appointment;
CREATE TRIGGER enforce_appointment_tenant_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, provider_id, room_id
ON luminary.appointment
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_appointment_tenant_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_patient_encounter_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_patient uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');

  IF NEW.encounter_id IS NOT NULL THEN
    SELECT patient_id INTO encounter_patient
      FROM luminary.encounter
     WHERE id = NEW.encounter_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF encounter_patient IS NULL THEN
      RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF encounter_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Encounter must belong to the same patient' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_lab_result_patient_refs ON luminary.lab_result;
CREATE TRIGGER enforce_lab_result_patient_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id
ON luminary.lab_result
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_patient_encounter_refs();

DROP TRIGGER IF EXISTS enforce_care_plan_patient_refs ON luminary.care_plan;
CREATE TRIGGER enforce_care_plan_patient_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id
ON luminary.care_plan
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_patient_encounter_refs();

DROP TRIGGER IF EXISTS enforce_referral_patient_refs ON luminary.referral;
CREATE TRIGGER enforce_referral_patient_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id
ON luminary.referral
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_patient_encounter_refs();

DROP TRIGGER IF EXISTS enforce_prescription_patient_refs ON luminary.prescription;
CREATE TRIGGER enforce_prescription_patient_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id
ON luminary.prescription
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_patient_encounter_refs();

DROP TRIGGER IF EXISTS enforce_patient_document_refs ON luminary.patient_document;
CREATE TRIGGER enforce_patient_document_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id
ON luminary.patient_document
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_patient_encounter_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_clinical_order_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_patient uuid;
  invoice_patient uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  IF NEW.encounter_id IS NOT NULL THEN
    SELECT patient_id INTO encounter_patient
      FROM luminary.encounter
     WHERE id = NEW.encounter_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF encounter_patient IS NULL THEN
      RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF encounter_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Encounter must belong to the order patient' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM luminary.require_same_practice('luminary.service', NEW.service_id, 'Service');
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT patient_id INTO invoice_patient
      FROM luminary.invoice
     WHERE id = NEW.invoice_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF invoice_patient IS NULL THEN
      RAISE EXCEPTION 'Invoice is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF invoice_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Invoice must belong to the order patient' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_clinical_order_refs ON luminary.clinical_order;
CREATE TRIGGER enforce_clinical_order_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id, service_id, invoice_id
ON luminary.clinical_order
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_clinical_order_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_access_grant_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.user_id, 'Granted user');
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.granted_by, 'Granting user');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_access_grant_refs ON luminary.access_grant;
CREATE TRIGGER enforce_access_grant_refs
BEFORE INSERT OR UPDATE OF practice_id, user_id, patient_id, granted_by
ON luminary.access_grant
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_access_grant_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_invoice_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_invoice_refs ON luminary.invoice;
CREATE TRIGGER enforce_invoice_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id
ON luminary.invoice
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_invoice_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_invoice_line_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_patient uuid;
  order_patient uuid;
  encounter_patient uuid;
BEGIN
  SELECT patient_id INTO invoice_patient
    FROM luminary.invoice
   WHERE id = NEW.invoice_id
     AND practice_id = luminary.current_practice_id()
     AND deleted_at IS NULL;
  IF invoice_patient IS NULL THEN
    RAISE EXCEPTION 'Invoice is not in this practice' USING ERRCODE = '23514';
  END IF;

  PERFORM luminary.require_same_practice('luminary.service', NEW.service_id, 'Service');
  PERFORM luminary.require_same_practice('luminary.tariff', NEW.tariff_id, 'Tariff');

  IF NEW.order_id IS NOT NULL THEN
    SELECT patient_id INTO order_patient
      FROM luminary.clinical_order
     WHERE id = NEW.order_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF order_patient IS NULL THEN
      RAISE EXCEPTION 'Order is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF order_patient IS DISTINCT FROM invoice_patient THEN
      RAISE EXCEPTION 'Order must belong to the invoice patient' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.encounter_id IS NOT NULL THEN
    SELECT patient_id INTO encounter_patient
      FROM luminary.encounter
     WHERE id = NEW.encounter_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF encounter_patient IS NULL THEN
      RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF encounter_patient IS DISTINCT FROM invoice_patient THEN
      RAISE EXCEPTION 'Encounter must belong to the invoice patient' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_invoice_line_refs ON luminary.invoice_line;
CREATE TRIGGER enforce_invoice_line_refs
BEFORE INSERT OR UPDATE OF practice_id, invoice_id, service_id, tariff_id, order_id, encounter_id
ON luminary.invoice_line
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_invoice_line_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_claim_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_patient uuid;
  encounter_patient uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.payer', NEW.payer_id, 'Payer');
  PERFORM luminary.require_same_practice('luminary.scheme', NEW.scheme_id, 'Scheme');

  SELECT patient_id INTO invoice_patient
    FROM luminary.invoice
   WHERE id = NEW.invoice_id
     AND practice_id = luminary.current_practice_id()
     AND deleted_at IS NULL;
  IF invoice_patient IS NULL THEN
    RAISE EXCEPTION 'Invoice is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF invoice_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Claim invoice must belong to the claim patient' USING ERRCODE = '23514';
  END IF;

  IF NEW.encounter_id IS NOT NULL THEN
    SELECT patient_id INTO encounter_patient
      FROM luminary.encounter
     WHERE id = NEW.encounter_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF encounter_patient IS NULL THEN
      RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF encounter_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Claim encounter must belong to the claim patient' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_claim_refs ON luminary.claim;
CREATE TRIGGER enforce_claim_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, invoice_id, encounter_id, payer_id, scheme_id
ON luminary.claim
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_claim_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_claim_line_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim_invoice uuid;
  invoice_line_invoice uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.claim', NEW.claim_id, 'Claim');
  PERFORM luminary.require_same_practice('luminary.service', NEW.service_id, 'Service');

  IF NEW.invoice_line_id IS NOT NULL THEN
    SELECT c.invoice_id, il.invoice_id INTO claim_invoice, invoice_line_invoice
      FROM luminary.claim c
      JOIN luminary.invoice_line il ON il.id = NEW.invoice_line_id
     WHERE c.id = NEW.claim_id
       AND c.practice_id = luminary.current_practice_id()
       AND il.practice_id = luminary.current_practice_id()
       AND c.deleted_at IS NULL
       AND il.deleted_at IS NULL;
    IF invoice_line_invoice IS NULL THEN
      RAISE EXCEPTION 'Invoice line is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF claim_invoice IS DISTINCT FROM invoice_line_invoice THEN
      RAISE EXCEPTION 'Claim line invoice line must belong to the claim invoice' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_claim_line_refs ON luminary.claim_line;
CREATE TRIGGER enforce_claim_line_refs
BEFORE INSERT OR UPDATE OF practice_id, claim_id, invoice_line_id, service_id
ON luminary.claim_line
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_claim_line_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_payment_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim_invoice uuid;
  remittance_claim uuid;
BEGIN
  PERFORM luminary.require_same_practice('luminary.invoice', NEW.invoice_id, 'Invoice');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.received_by, 'Receiving user');
  PERFORM luminary.require_same_practice('luminary.payment', NEW.reverses_id, 'Reversed payment');
  PERFORM luminary.require_same_practice('luminary.payer', NEW.payer_id, 'Payer');

  IF NEW.claim_id IS NOT NULL THEN
    SELECT invoice_id INTO claim_invoice
      FROM luminary.claim
     WHERE id = NEW.claim_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF claim_invoice IS NULL THEN
      RAISE EXCEPTION 'Claim is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF claim_invoice IS DISTINCT FROM NEW.invoice_id THEN
      RAISE EXCEPTION 'Payment claim must belong to the payment invoice' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.remittance_id IS NOT NULL THEN
    SELECT claim_id INTO remittance_claim
      FROM luminary.claim_remittance
     WHERE id = NEW.remittance_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF remittance_claim IS NULL THEN
      RAISE EXCEPTION 'Remittance is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF NEW.claim_id IS NOT NULL AND remittance_claim IS NOT NULL AND remittance_claim IS DISTINCT FROM NEW.claim_id THEN
      RAISE EXCEPTION 'Payment remittance must belong to the payment claim' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_payment_refs ON luminary.payment;
CREATE TRIGGER enforce_payment_refs
BEFORE INSERT OR UPDATE OF practice_id, invoice_id, received_by, reverses_id, claim_id, remittance_id, payer_id
ON luminary.payment
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_payment_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_collection_case_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_patient uuid;
  claim_invoice uuid;
BEGIN
  SELECT patient_id INTO invoice_patient
    FROM luminary.invoice
   WHERE id = NEW.invoice_id
     AND practice_id = luminary.current_practice_id()
     AND deleted_at IS NULL;
  IF invoice_patient IS NULL THEN
    RAISE EXCEPTION 'Invoice is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF invoice_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Collection case patient must match invoice patient' USING ERRCODE = '23514';
  END IF;

  IF NEW.claim_id IS NOT NULL THEN
    SELECT invoice_id INTO claim_invoice
      FROM luminary.claim
     WHERE id = NEW.claim_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF claim_invoice IS NULL THEN
      RAISE EXCEPTION 'Claim is not in this practice' USING ERRCODE = '23514';
    END IF;
    IF claim_invoice IS DISTINCT FROM NEW.invoice_id THEN
      RAISE EXCEPTION 'Collection case claim must belong to invoice' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM luminary.require_same_practice('luminary.app_user', NEW.assigned_to, 'Assigned user');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_collection_case_refs ON luminary.collection_case;
CREATE TRIGGER enforce_collection_case_refs
BEFORE INSERT OR UPDATE OF practice_id, invoice_id, claim_id, patient_id, assigned_to
ON luminary.collection_case
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_collection_case_refs();
