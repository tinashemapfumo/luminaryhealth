# NH263 Integration Requirements

Luminary Health now owns a canonical medical aid claim model. NH263/New Health 263 should plug in as a claims adapter that maps Luminary claims to the official switch format and normalises responses back into Luminary status, adjudication, billing, and finance records.

## What Exists Internally

- Canonical claims are stored in `luminary.claim`.
- Claim line items are stored in `luminary.claim_line`.
- Submitted ICD-10 diagnoses are stored in `luminary.claim_diagnosis`, separate from encounter diagnoses so billing staff can correct claim coding without rewriting clinical notes.
- Claim events are immutable timeline rows in `luminary.claim_event`.
- Outbound and inbound exchanges are tracked in `luminary.claim_transmission`.
- Payer responses are normalised into `luminary.claim_adjudication`.
- Claim attachments reference existing `patient_document` rows through `luminary.claim_attachment`.
- Remittance, eligibility, and prior-authorisation structures exist for later switch and finance workflows.

## Adapter Boundary

Adapters implement the claims contract in `luminary-server/src/modules/claims/claims.types.ts`.

Current adapters:

- `ManualClaimAdapter`: marks a claim for manual handling.
- `EmailPdfClaimAdapter`: keeps the same canonical claim and prepares for PDF/email submission.
- `NH263Adapter`: intentionally skeletal until official NH263 documentation and credentials are supplied.

The NH263 adapter must not invent endpoints or payload fields. Its job will be to:

- validate Luminary claims against NH263-specific rules,
- map the canonical claim snapshot to the NH263 request payload,
- submit to the official endpoint,
- normalise acknowledgements, status responses, adjudication, errors, and remittances,
- preserve idempotency and transmission history.

## Information Still Required From NH263

- Sandbox/test base URL.
- Production base URL.
- Authentication method.
- Credential onboarding process.
- Provider/practice registration requirements.
- Claim submission endpoint.
- Claim submission payload/schema.
- Required tariff format and payer-specific tariff rules.
- ICD-10 requirements and diagnosis-line linkage rules.
- Membership verification endpoint.
- Biometric interface/specification.
- Eligibility endpoint.
- Prior-authorisation endpoint.
- Document upload or attachment mechanism.
- Claim status endpoint.
- Callback/webhook specification.
- Webhook authentication/signature verification protocol.
- Response/adjudication schema.
- Reason, rejection, and error-code catalogue.
- Remittance advice format.
- Idempotency requirements.
- Certification/UAT process.
- IP allow-listing, VPN, mTLS, or certificate requirements.
- Rate limits.
- Timeout, retry, and backoff expectations.

## Security Notes

- Secrets must not be returned to browsers or stored in ordinary configuration fields.
- Raw external payload retention should use protected references, not normal application logs.
- Claims are tenant-scoped with the existing RLS pattern.
- Claim submission creates an immutable snapshot so later edits to patient, provider, tariff, or diagnosis data do not rewrite what was actually submitted.
- NH263 callbacks are exposed only as a placeholder route until the official verification protocol is known.
