# Canonical Claims Architecture

Luminary Health owns the claim domain. External switches such as NH263/New Health 263 are transport adapters that map to and from Luminary's canonical claim model.

## Existing Pieces Reused

- Patients already hold medical aid cover, member number, dependant code, consent, and primary provider.
- Encounters already store signed clinical notes and ICD-10-style diagnosis objects.
- Invoices and invoice lines already carry services, tariff codes, estimated funder portions, and patient portions.
- `service`, `payer`, `scheme`, and `tariff` already support payer-specific pricing.
- `patient_document` already stores clinical documents outside the database and keeps tenant-scoped metadata.
- RBAC, RLS, server-side sessions, and audit logging already exist and are reused.

## Canonical Flow

Clinical workflow -> Billing -> Claims engine -> Canonical claim snapshot -> Claims adapter -> External switch/provider -> Normalized response -> Claim adjudication -> Billing/finance.

The important boundary is the snapshot. Once a claim is submitted, Luminary preserves what was sent even if patient demographics, provider details, tariff mappings, or encounter coding change later.

## Lifecycle

Canonical statuses are:

`DRAFT`, `READY`, `VALIDATION_FAILED`, `READY_FOR_SUBMISSION`, `SUBMITTING`, `SUBMITTED`, `ACKNOWLEDGED`, `PROCESSING`, `APPROVED`, `PARTIALLY_APPROVED`, `REJECTED`, `QUERY`, `REQUIRES_ACTION`, `CANCELLED`, `FAILED`.

The claim keeps internal status, external/switch status, and funder status separately so a switch acknowledgement is not confused with payer approval.

## Tables Added

- `claim_line`: multi-line claim services with claimed, approved, rejected, insurer, and member amounts.
- `claim_diagnosis`: submitted diagnoses, including primary and secondary coding.
- `claim_event`: immutable claim timeline.
- `claim_transmission`: outbound/inbound adapter exchanges without dumping PHI into normal logs.
- `claim_adjudication`: normalized payer outcome at claim level.
- `claim_attachment`: references existing patient documents.
- `claim_remittance`: future remittance advice/reconciliation.
- `claim_eligibility_result`: member verification and eligibility results.
- `claim_authorisation`: prior-authorisation readiness.

## Adapter Layer

The adapter contract lives in `src/modules/claims/claims.types.ts`.

Implemented adapters:

- `ManualClaimAdapter`
- `EmailPdfClaimAdapter`
- `NH263Adapter`

The NH263 adapter is intentionally not wired to real URLs or payload fields. It refuses validation/submission until the official specification is supplied.

## API Surface

- `GET /claims`
- `POST /claims`
- `GET /claims/:id`
- `PATCH /claims/:id`
- `POST /claims/:id/validate`
- `POST /claims/:id/submit`
- `POST /claims/:id/refresh-status`
- `GET /claims/:id/events`
- `GET /claims/:id/transmissions`
- `GET /claims/:id/adjudication`
- `POST /claims/:id/attachments`
- `GET /claims/configuration`
- `POST /integrations/nh263/webhook`

Legacy frontend compatibility routes for biometric capture and submission remain in the claims module.

## Validation

Base validation checks patient, funder/scheme, membership, service date, claim lines, tariff codes, amounts, practitioner presence, and primary diagnosis. Adapter-specific validation is layered after this so NH263 requirements can be added without hard-coding every payer rule into the core service.

## Security

- All new claim tables use the existing tenant RLS helper.
- Mutations go through existing role permissions and audit writes.
- Transmission rows store normalized results and protected raw-payload references, not ordinary raw PHI dumps.
- Attachments reference existing patient documents and preserve clinical permissions.
- Machine callbacks are represented by a placeholder route only until the real NH263 verification protocol is known.
