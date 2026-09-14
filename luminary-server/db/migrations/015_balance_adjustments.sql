-- =============================================================================
-- 015 · Balance adjustments — write-offs and credit notes
-- =============================================================================
--
-- `recordPayment` refuses an overpayment with the advice to "raise a separate
-- credit", and until now there was nothing to raise it with. A rejected claim
-- left a patient portion that nothing could discharge: the scheme had declined
-- it, the patient would not pay it, and cash was the only instrument in the
-- system. Those balances aged for ever and quietly overstated the receivable.
--
-- An adjustment is a ledger row, never an edit to the invoice — the same rule
-- the payment table follows, and for the same reason. It is kept in its own
-- table rather than booked as a payment of a peculiar kind, because the
-- difference between money collected and debt forgiven is the difference
-- between a healthy practice and one that is failing to collect. A single
-- table would make that distinction a matter of reading the method column
-- correctly, every time, for ever.

SET search_path = luminary, public;

CREATE TABLE luminary.invoice_adjustment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid          NOT NULL REFERENCES luminary.practice(id),
  invoice_id  uuid          NOT NULL REFERENCES luminary.invoice(id),
  kind        text          NOT NULL CHECK (kind IN ('write_off', 'credit_note')),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  currency    text          NOT NULL DEFAULT 'ZWL',
  -- Not nullable and not trivially satisfiable. An adjustment with no stated
  -- reason is indistinguishable from a mistake or a theft.
  reason      text          NOT NULL CHECK (length(btrim(reason)) >= 10),
  decided_by  uuid          NOT NULL REFERENCES luminary.app_user(id),
  decided_at  timestamptz   NOT NULL DEFAULT now(),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text
);

CREATE INDEX invoice_adjustment_invoice_idx
  ON luminary.invoice_adjustment (invoice_id)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.invoice_adjustment');

-- Carried on the invoice alongside amount_paid so that "what is still owed" is
-- one subtraction rather than a correlated subquery in every report that asks.
ALTER TABLE luminary.invoice
  ADD COLUMN IF NOT EXISTS amount_adjusted numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN luminary.invoice.amount_adjusted IS
  'Written off or credited. Discharges the balance without any money arriving, '
  'so it is never added to amount_paid.';
