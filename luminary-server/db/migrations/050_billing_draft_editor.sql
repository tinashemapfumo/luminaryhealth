-- =============================================================================
-- 050 - Billing handoff Phases 4-5: draft invoice editor, clarifications,
--        bespoke-price agreements, and finalization
-- =============================================================================
--
-- Additive only. `finalized_at` on the invoice is the lock: once set, the
-- draft-invoice editing functions in billing.service.ts refuse further line
-- mutations and corrections must go through the existing adjustment/reversal
-- machinery instead of rewriting a finalized line — the same discipline
-- already used for payments (never edited, only reversed).

SET search_path = luminary, public;

ALTER TABLE luminary.invoice
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS patient_note text;

ALTER TABLE luminary.invoice_line
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bespoke_price_agreement_id uuid REFERENCES luminary.bespoke_price_agreement(id),
  ADD COLUMN IF NOT EXISTS excluded_by uuid REFERENCES luminary.app_user(id),
  ADD COLUMN IF NOT EXISTS excluded_at timestamptz;

CREATE TABLE luminary.billing_clarification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id    uuid        NOT NULL REFERENCES luminary.practice(id),
  work_item_id   uuid        NOT NULL REFERENCES luminary.billing_work_item(id),
  category       text        NOT NULL CHECK (category IN (
                    'missing_service', 'service_not_completed', 'diagnosis_code',
                    'quantity', 'pricing_agreement', 'other'
                  )),
  question       text        NOT NULL,
  response       text,
  status         text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
  requested_by   uuid        NOT NULL REFERENCES luminary.app_user(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  responded_by   uuid REFERENCES luminary.app_user(id),
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  origin_node    text
);

CREATE INDEX billing_clarification_work_item_idx
  ON luminary.billing_clarification (practice_id, work_item_id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.enforce_billing_clarification_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('luminary.replicating', true) = 'on' THEN RETURN NEW; END IF;
  PERFORM luminary.require_same_practice('luminary.billing_work_item', NEW.work_item_id, 'Work item');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.requested_by, 'Requesting user');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.responded_by, 'Responding user');
  RETURN NEW;
END
$$;

CREATE TRIGGER enforce_billing_clarification_refs
BEFORE INSERT OR UPDATE OF practice_id, work_item_id, requested_by, responded_by
ON luminary.billing_clarification
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_billing_clarification_refs();

SELECT luminary.make_tenant_table('luminary.billing_clarification');
