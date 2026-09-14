-- =============================================================================
-- 024 · Scenario 003 diagnostic ordering and safety remediation
-- =============================================================================
--
-- Keeps diagnostic services offline-first through reviewed service imports,
-- links resulted labs back to the order/encounter that produced them, and marks
-- whether a catalogue service can be ordered clinically.

SET search_path = luminary, public;

ALTER TABLE luminary.service
  ADD COLUMN IF NOT EXISTS orderable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN luminary.service.orderable IS
  'Whether this catalogue item can be ordered clinically. Billing-only catalogue rows stay available for invoices but out of the order picker.';

ALTER TABLE luminary.lab_result
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES luminary.clinical_order(id),
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES luminary.encounter(id);

COMMENT ON COLUMN luminary.lab_result.order_id IS
  'The clinical order this result fulfils, when it came from an order.';

COMMENT ON COLUMN luminary.lab_result.encounter_id IS
  'The visit/note context for this result, copied from the order or supplied at capture.';

CREATE INDEX IF NOT EXISTS lab_result_order_idx
  ON luminary.lab_result (practice_id, order_id)
  WHERE deleted_at IS NULL AND order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lab_result_encounter_idx
  ON luminary.lab_result (practice_id, encounter_id)
  WHERE deleted_at IS NULL AND encounter_id IS NOT NULL;
