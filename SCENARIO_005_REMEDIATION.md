# Scenario 005 Remediation

## Verdict

Targeted remediation implemented for the Scenario 005 billing integrity defects.

## Canonical Billing Paths

Clinical charge:

```text
clinical event/order -> service catalogue -> service price/tariff -> invoice_line(origin=clinical) -> invoice -> payment -> balance
```

Manual charge:

```text
manual financial reason -> invoice_line(origin=manual) -> invoice -> payment -> balance
```

Manual invoicing remains available for non-clinical charges. Clinical billing now preserves structured provenance when generated from orders.

## Fixes

- Cross-tenant invoice creation now fails before persistence.
- Database guard triggers reject cross-practice financial references for invoices, invoice lines, payments, and adjustments.
- `GET /payers` now reads plans from `luminary.scheme`, matching the migration 016 architecture.
- `GET /tariffs` no longer fails through the broken payer lookup.
- Automated order billing writes `origin=clinical`, `service_id`, `order_id`, `encounter_id`, `tariff_id`, `tariff_via`, and `billing_key`.
- Manual invoice lines write `origin=manual`.
- Manual invoice request replay is protected with `invoice.idempotency_key`.
- Payment request replay is protected with `payment.idempotency_key`.
- Live frontend invoice and payment calls send idempotency keys.
- Live frontend invoice-line mapping now preserves structured provenance fields returned by the API.

## Database Changes

Migration:

```text
025_scenario005_billing_integrity.sql
```

Added:

- `invoice.idempotency_key`
- `invoice_line.origin`
- `invoice_line.encounter_id`
- `payment.idempotency_key`
- unique partial indexes for invoice and payment idempotency keys
- same-practice guard triggers for financial references

## Verification Highlights

- `/health` returned `ok`.
- `GET /payers` returned a valid response.
- `GET /tariffs` returned a valid response.
- Harare manager attempting to invoice a Bulawayo patient returned `404 NotFound`.
- Imported a billable FBC service through the service import path.
- Completed an FBC order and generated a structured invoice line.
- Replaying the same completed order did not duplicate the line.
- Payment replay with the same idempotency key returned the original payment.
- A second payment with a different key created a legitimate new payment.
- Manual invoice replay with the same idempotency key returned the original invoice.
- A second manual invoice with a different key created a legitimate new invoice.

## Claims Readiness

The clinical-order to invoice-line chain is now trustworthy enough for the next scenario to test claim generation from structured billing data, provided the rerun confirms the same results on a fresh Scenario 005 patient.
