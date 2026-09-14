# Scenario 006 Remediation

## Scope

Scenario 006 fixes the internal readiness path for medical-aid claims. It does not implement live NH263 transport or invent NH263 payloads.

## Implemented

- Fixed canonical claim creation from invoices by casting numeric parameters in the claim insert.
- Added live payer creation through `POST /payers`.
- Added live scheme creation through `POST /schemes` and `POST /settings/schemes`.
- Allowed scheme maintenance through the `manageCover` permission instead of requiring broad system configuration authority.
- Extended patient registration and patient updates to carry cover details:
  - scheme
  - member number
  - principal member
  - dependant code
  - cover effective date
  - cover valid-until date
  - cover status
- Added patient-cover validation so cover expiry cannot predate the cover start date.
- Added same-practice scheme validation before assigning cover to a patient.
- Updated invoice pricing to use patient cover only when it is active for the billing date.
- Updated invoice-derived claims to copy cover only when it is active for the invoice date.
- Added database integrity for repeatable cover configuration:
  - live payer names unique per practice
  - live scheme names unique per payer and practice
  - patient cover date ordering

## Claim Source Of Truth

The invoice remains the financial source of truth.

The claim is derived from the invoice and snapshots the claimable data at the point of preparation:

`Patient -> Episode -> Visit -> Notes/Orders -> Invoice -> Claim`

That preserves the accounting principle:

- the invoice creates the charge
- the payment reduces patient balance
- the claim represents expected insurer exposure
- adjudication updates what the insurer approved, rejected, or queried

## International Email Claims

International medical-aid claims should use the canonical claim model with `submission_channel = EMAIL_PDF`.

The architecture is:

- prepare claim from invoice
- validate membership, payer, tariff, invoice lines, and diagnosis data
- generate or attach claim PDF/supporting documents
- send or mark as sent by email
- record payer replies as claim events/adjudication
- reconcile payments against insurer exposure

The current adapter is intentionally internal/stubbed. It gives the product a safe place to prepare and track email claims without claiming that SMTP, PDF templates, or payer-specific forms are already complete.

## NH263 Membership Checking

NH263 should be treated as an adapter with several capabilities, not only claim submission.

Future NH263 adapter capabilities should be:

- `checkEligibility` or `verifyMembership`
- `submitClaim`
- `refreshClaimStatus`
- `fetchRemittance`
- `reconcileRemittance`

The database already has fields for cover verification status and timestamps, plus canonical claim transmission/adjudication tables. The next NH263 implementation should plug into those fields once official payload, authentication, endpoint, status, and remittance specifications are supplied.

## Not Implemented

- Live NH263 API calls
- NH263 payload mapping
- SMTP sending
- payer-specific PDF claim forms
- automated remittance fetching

Those remain external-integration work, not Scenario 006 defect remediation.
