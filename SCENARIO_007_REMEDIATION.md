# Scenario 007 Remediation

## Scope

Scenario 007 fixes internal claim submission state integrity only.

It does not implement NH263 transport, invent NH263 payloads, fabricate webhooks, or begin Scenario 008.

## Root Cause

`claimsService.submit()` allowed a caller to override the submission channel for a submission attempt, but did not persist the channel that actually handled the claim.

That left this invalid state possible:

```text
claim.submission_channel = NH263
latest successful transmission.adapter = MANUAL
claim.external_reference = MANUAL-...
```

`refreshStatus()` then selected its adapter from the stale claim field, called the wrong adapter, and could overwrite a truthful manual claim state with a false NH263 failure.

## Implemented

- `claim.submission_channel` now means the last actual submission/refresh channel for the claim.
- `submit()` persists the resolved channel when the claim enters `SUBMITTING`.
- Successful and failed submission outcomes keep the claim channel aligned with the transmission adapter.
- `FAILED` is retryable through the normal validate/submit path.
- `refreshStatus()` prefers the latest outbound transmission channel when one exists, then falls back to `claim.submission_channel`.
- Refresh fails closed if the external reference does not match the selected adapter family.
- Manual and email references cannot be refreshed through NH263.
- Switch references cannot be refreshed through manual/email channels.
- Transmission history remains append-only.

## Legal Recovery

`FAILED` is not treated as a final payer outcome. It represents a failed attempt or integration failure.

Allowed:

```text
FAILED -> validate -> READY_FOR_SUBMISSION
FAILED -> submit -> SUBMITTING -> ACKNOWLEDGED/FAILED
```

Still blocked:

```text
APPROVED/PARTIALLY_APPROVED/REJECTED -> submit
```

## Source Of Truth

The claim row carries the headline state used by the UI and reports.

`claim_transmission` remains the append-only operational history:

- adapter
- direction
- attempt number
- request reference
- external reference
- normalized result
- error code/message

When choosing a refresh adapter, the service uses the latest outbound transmission where available, because that is the best record of the channel that actually handled the claim.

## NH263 Boundary

NH263 remains an honest stub until official specification and test credentials are available.

External NH263 phases remain blocked:

```text
BLOCKED - official NH263 submission specification and/or test credentials are unavailable.
```
