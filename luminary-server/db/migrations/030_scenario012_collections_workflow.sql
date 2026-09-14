-- =============================================================================
-- 030 . Scenario 012 denial accounting and minimal collections workflow
-- =============================================================================
-- The workflow tables hold operational follow-up state only. Balances remain
-- derived from invoices, claims, payments, adjustments and denial dispositions.

SET search_path = luminary, public;

CREATE TABLE IF NOT EXISTS luminary.collection_case (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id     uuid        NOT NULL REFERENCES luminary.practice(id),
  invoice_id      uuid        NOT NULL REFERENCES luminary.invoice(id),
  claim_id        uuid        REFERENCES luminary.claim(id),
  patient_id      uuid        NOT NULL REFERENCES luminary.patient(id),
  debtor_type     text        NOT NULL
    CHECK (debtor_type IN ('PATIENT','INSURER','UNRESOLVED_DENIAL')),
  status          text        NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','FOLLOW_UP','DISPUTED','RESOLVED')),
  assigned_to     uuid        REFERENCES luminary.app_user(id),
  assigned_at     timestamptz,
  next_action_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  deleted_at      timestamptz,
  origin_node     text
);

CREATE UNIQUE INDEX IF NOT EXISTS collection_case_one_live_debtor_idx
  ON luminary.collection_case
    (practice_id, invoice_id, debtor_type, COALESCE(claim_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS collection_case_worklist_idx
  ON luminary.collection_case (practice_id, status, debtor_type, next_action_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS collection_case_assignee_idx
  ON luminary.collection_case (practice_id, assigned_to, next_action_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS luminary.collection_action (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id        uuid        NOT NULL REFERENCES luminary.practice(id),
  collection_case_id uuid        NOT NULL REFERENCES luminary.collection_case(id),
  actor_id           uuid        NOT NULL REFERENCES luminary.app_user(id),
  action_type        text        NOT NULL
    CHECK (action_type IN ('NOTE','PHONE_CALL','FOLLOW_UP','EMAIL','WHATSAPP','STATUS_CHANGE','ASSIGNMENT')),
  note               text        NOT NULL CHECK (length(btrim(note)) >= 3),
  next_action_at     timestamptz,
  reference          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  origin_node        text
);

CREATE INDEX IF NOT EXISTS collection_action_case_idx
  ON luminary.collection_action (practice_id, collection_case_id, created_at)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.guard_collection_case_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice record;
  v_claim record;
  v_user_practice uuid;
BEGIN
  SELECT practice_id, patient_id INTO v_invoice
    FROM luminary.invoice
   WHERE id = NEW.invoice_id AND deleted_at IS NULL;

  IF v_invoice.practice_id IS NULL OR v_invoice.practice_id <> NEW.practice_id THEN
    RAISE EXCEPTION 'Invoice not found'
      USING ERRCODE = '23503', CONSTRAINT = 'collection_case_invoice_same_practice';
  END IF;
  IF v_invoice.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'Patient does not match invoice'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_case_patient_invoice_match';
  END IF;

  IF NEW.claim_id IS NOT NULL THEN
    SELECT practice_id, invoice_id, patient_id INTO v_claim
      FROM luminary.claim
     WHERE id = NEW.claim_id AND deleted_at IS NULL;
    IF v_claim.practice_id IS NULL OR v_claim.practice_id <> NEW.practice_id THEN
      RAISE EXCEPTION 'Claim not found'
        USING ERRCODE = '23503', CONSTRAINT = 'collection_case_claim_same_practice';
    END IF;
    IF v_claim.invoice_id <> NEW.invoice_id OR v_claim.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'Claim does not match invoice'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_case_claim_invoice_match';
    END IF;
  END IF;

  IF NEW.debtor_type IN ('INSURER','UNRESOLVED_DENIAL') AND NEW.claim_id IS NULL THEN
    RAISE EXCEPTION 'Insurer and denial collection cases require claim context'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_case_claim_required';
  END IF;

  IF NEW.assigned_to IS NOT NULL THEN
    SELECT practice_id INTO v_user_practice
      FROM luminary.app_user
     WHERE id = NEW.assigned_to AND deleted_at IS NULL;
    IF v_user_practice IS NULL OR v_user_practice <> NEW.practice_id THEN
      RAISE EXCEPTION 'Assigned user not found'
        USING ERRCODE = '23503', CONSTRAINT = 'collection_case_assignee_same_practice';
    END IF;
    IF NEW.assigned_at IS NULL THEN
      NEW.assigned_at := now();
    END IF;
  ELSE
    NEW.assigned_at := NULL;
  END IF;

  IF NEW.status = 'RESOLVED' AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  ELSIF NEW.status <> 'RESOLVED' THEN
    NEW.resolved_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_case_reference_guard ON luminary.collection_case;
CREATE TRIGGER collection_case_reference_guard
BEFORE INSERT OR UPDATE OF practice_id, invoice_id, claim_id, patient_id, debtor_type, assigned_to, status
ON luminary.collection_case
FOR EACH ROW EXECUTE FUNCTION luminary.guard_collection_case_references();

CREATE OR REPLACE FUNCTION luminary.guard_collection_action_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_case_practice uuid;
  v_actor_practice uuid;
BEGIN
  SELECT practice_id INTO v_case_practice
    FROM luminary.collection_case
   WHERE id = NEW.collection_case_id AND deleted_at IS NULL;
  IF v_case_practice IS NULL OR v_case_practice <> NEW.practice_id THEN
    RAISE EXCEPTION 'Collection case not found'
      USING ERRCODE = '23503', CONSTRAINT = 'collection_action_case_same_practice';
  END IF;

  SELECT practice_id INTO v_actor_practice
    FROM luminary.app_user
   WHERE id = NEW.actor_id AND deleted_at IS NULL;
  IF v_actor_practice IS NULL OR v_actor_practice <> NEW.practice_id THEN
    RAISE EXCEPTION 'Actor not found'
      USING ERRCODE = '23503', CONSTRAINT = 'collection_action_actor_same_practice';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_action_reference_guard ON luminary.collection_action;
CREATE TRIGGER collection_action_reference_guard
BEFORE INSERT OR UPDATE OF practice_id, collection_case_id, actor_id
ON luminary.collection_action
FOR EACH ROW EXECUTE FUNCTION luminary.guard_collection_action_references();

SELECT luminary.make_tenant_table('luminary.collection_case');
SELECT luminary.make_tenant_table('luminary.collection_action');
