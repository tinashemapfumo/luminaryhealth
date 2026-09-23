-- =============================================================================
-- 049 - Billing handoff and charge capture (Phase 1: schema + capture)
-- =============================================================================
--
-- Gives the doctor a structured way to record what happened in a consultation
-- as billable clinical events, and gives signing an atomic hook to turn those
-- events into a draft invoice a billing user can review — without billing
-- staff ever reading the SOAP note.
--
-- Phase 1 only: capture + the signature handoff. The billing work queue,
-- clarification workflow, and bespoke-price approval UI are later phases;
-- `bespoke_price_agreement` is created here as schema-only groundwork and is
-- not yet consulted by price resolution.

SET search_path = luminary, public;

CREATE TABLE luminary.encounter_service_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id   uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id    uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id  uuid        NOT NULL REFERENCES luminary.encounter(id),
  service_id    uuid        NOT NULL REFERENCES luminary.service(id),
  order_id      uuid REFERENCES luminary.clinical_order(id),
  event_type    text        NOT NULL CHECK (event_type IN ('planned', 'ordered', 'performed')),
  quantity      int         NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status        text        NOT NULL DEFAULT 'captured'
                             CHECK (status IN ('captured', 'billed', 'excluded')),
  billing_note  text        NOT NULL DEFAULT '',
  billing_key   text,
  performed_by  uuid REFERENCES luminary.app_user(id),
  performed_at  timestamptz,
  created_by    uuid        NOT NULL REFERENCES luminary.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  origin_node   text
);

CREATE INDEX encounter_service_event_encounter_idx
  ON luminary.encounter_service_event (practice_id, encounter_id)
  WHERE deleted_at IS NULL;

CREATE TABLE luminary.billing_work_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id     uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id      uuid        NOT NULL REFERENCES luminary.patient(id),
  appointment_id  uuid REFERENCES luminary.appointment(id),
  encounter_id    uuid        NOT NULL REFERENCES luminary.encounter(id),
  draft_invoice_id uuid REFERENCES luminary.invoice(id),
  status          text        NOT NULL DEFAULT 'Expected' CHECK (status IN (
                    'Expected', 'In consultation', 'Awaiting clinician', 'Ready to bill',
                    'Needs clarification', 'Draft invoice', 'Finalized', 'Cancelled'
                  )),
  assigned_to     uuid REFERENCES luminary.app_user(id),
  billing_note    text        NOT NULL DEFAULT '',
  ready_at        timestamptz,
  finalized_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  origin_node     text
);

-- One active work item per encounter: the signature handoff must be able to
-- retry safely (a dropped connection replaying the same sign call) without
-- ever producing a second work item for the same consultation.
CREATE UNIQUE INDEX billing_work_item_encounter_idx
  ON luminary.billing_work_item (practice_id, encounter_id)
  WHERE deleted_at IS NULL;

CREATE TABLE luminary.bespoke_price_agreement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id     uuid          NOT NULL REFERENCES luminary.practice(id),
  patient_id      uuid          NOT NULL REFERENCES luminary.patient(id),
  service_id      uuid          NOT NULL REFERENCES luminary.service(id),
  appointment_id  uuid REFERENCES luminary.appointment(id),
  encounter_id    uuid REFERENCES luminary.encounter(id),
  amount          numeric(12,2) NOT NULL,
  currency        text          NOT NULL,
  reason          text          NOT NULL,
  scope           text          NOT NULL DEFAULT 'one_encounter'
                                 CHECK (scope IN ('one_encounter', 'date_range', 'use_count')),
  valid_from      date          NOT NULL DEFAULT current_date,
  valid_until     date,
  uses_remaining  int CHECK (uses_remaining IS NULL OR uses_remaining >= 0),
  status          text          NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_by      uuid          NOT NULL REFERENCES luminary.app_user(id),
  approved_by     uuid REFERENCES luminary.app_user(id),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  origin_node     text
);

-- Snapshot and provenance columns for draft/finalized invoice lines proposed
-- from the billing handoff. `description`, `tariff_code`, `unit_price`, and
-- `tariff_via` already snapshot the catalogue at charge time (migration 016);
-- these extend that with the human-readable service name and which billing
-- handoff step produced the line.
ALTER TABLE luminary.invoice_line
  ADD COLUMN IF NOT EXISTS service_event_id uuid REFERENCES luminary.encounter_service_event(id),
  ADD COLUMN IF NOT EXISTS service_display_name_snapshot text,
  ADD COLUMN IF NOT EXISTS line_source text NOT NULL DEFAULT 'manual'
    CHECK (line_source IN ('encounter', 'completed_order', 'billing', 'front_desk_agreement', 'manual')),
  ADD COLUMN IF NOT EXISTS exclusion_status text CHECK (exclusion_status IS NULL OR exclusion_status IN ('excluded')),
  ADD COLUMN IF NOT EXISTS exclusion_reason text;

CREATE OR REPLACE FUNCTION luminary.enforce_encounter_service_event_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_patient uuid;
  order_patient uuid;
BEGIN
  IF current_setting('luminary.replicating', true) = 'on' THEN RETURN NEW; END IF;
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.service', NEW.service_id, 'Service');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.performed_by, 'Performing user');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.created_by, 'Creating user');

  SELECT patient_id INTO encounter_patient
    FROM luminary.encounter
   WHERE id = NEW.encounter_id AND practice_id = luminary.current_practice_id() AND deleted_at IS NULL;
  IF encounter_patient IS NULL THEN
    RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF encounter_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Service event must belong to the encounter patient' USING ERRCODE = '23514';
  END IF;

  IF NEW.order_id IS NOT NULL THEN
    SELECT patient_id INTO order_patient
      FROM luminary.clinical_order
     WHERE id = NEW.order_id AND practice_id = luminary.current_practice_id() AND deleted_at IS NULL;
    IF order_patient IS NULL OR order_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Linked order must belong to the same patient' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER enforce_encounter_service_event_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id, service_id, order_id, performed_by, created_by
ON luminary.encounter_service_event
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_encounter_service_event_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_billing_work_item_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_patient uuid;
  invoice_patient uuid;
BEGIN
  IF current_setting('luminary.replicating', true) = 'on' THEN RETURN NEW; END IF;
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.appointment', NEW.appointment_id, 'Appointment');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.assigned_to, 'Assigned user');

  SELECT patient_id INTO encounter_patient
    FROM luminary.encounter
   WHERE id = NEW.encounter_id AND practice_id = luminary.current_practice_id() AND deleted_at IS NULL;
  IF encounter_patient IS NULL THEN
    RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF encounter_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Work item must belong to the encounter patient' USING ERRCODE = '23514';
  END IF;

  IF NEW.draft_invoice_id IS NOT NULL THEN
    SELECT patient_id INTO invoice_patient
      FROM luminary.invoice
     WHERE id = NEW.draft_invoice_id AND practice_id = luminary.current_practice_id() AND deleted_at IS NULL;
    IF invoice_patient IS NULL OR invoice_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Draft invoice must belong to the same patient' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER enforce_billing_work_item_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, appointment_id, encounter_id, draft_invoice_id, assigned_to
ON luminary.billing_work_item
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_billing_work_item_refs();

SELECT luminary.make_tenant_table('luminary.encounter_service_event');
SELECT luminary.make_tenant_table('luminary.billing_work_item');
SELECT luminary.make_tenant_table('luminary.bespoke_price_agreement');
