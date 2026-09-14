# Billing Page Structure

## Purpose

Billing has two different jobs:

1. Practice-wide finance control.
2. Patient-specific account work.

Those jobs should share the same invoice, claim, receipt, and adjustment data, but they should not share the same screen layout.

## Chosen Structure

Luminary Health uses Option 3: split billing into a practice-wide Billing module and a patient-only account view.

The sidebar Billing page now has these tabs:

- `Overview`
- `Accounts`
- `Invoices`
- `Claims exposure`
- `Receipts`

The `Accounts` tab opens a patient account view. Once a patient account is open, the screen shows only that patient's invoices, claims, payments, adjustments, and statement ledger. Other patient names are hidden until the user goes back to the account list.

## Patient File Behaviour

When Billing is opened inside a patient file, only the current patient's billing records should appear.

The patient-file Billing tab shows:

- Patient account totals
- Patient invoices
- Patient payments
- Patient claims

It must not show:

- Practice-wide invoice queues
- Other patient names
- Global aging buckets
- Global claims exposure

## Statement Logic

The account statement should behave like a ledger:

- Invoice rows are debits.
- Payments are credits.
- Reversals are debits.
- Write-offs and credits are credits.
- Each row carries a running balance.

Patient responsibility and insurer exposure are kept separate. Patients should not be chased for insurer portions unless the claim is rejected or that amount is deliberately moved to patient responsibility.

## Current Implementation

The current implementation is front-end only and follows the existing persisted workspace pattern. The production backend should enforce the same separation:

- Practice-wide endpoints for finance dashboards and queues.
- Patient-account endpoints scoped by patient id.
- Server-side statement ledger calculation.
- Permission checks so patient-file billing cannot leak other patient account data.
