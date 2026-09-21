# Executive Insight reporting API

Executive Insight is Luminary's read-only aggregate reporting surface for trusted machine workflows such as n8n. Luminary owns authentication, practice selection, metric definitions, database access, aggregation, and privacy. The workflow receives neither database credentials nor a generic query facility.

## Canonical contract

Canonical routes require the `agent:report` integration scope:

| n8n report tool | Method and path | Response data |
| --- | --- | --- |
| Executive summary | `POST /agent/reports/executive-summary` | `body.data` |
| Revenue | `POST /agent/reports/revenue` | `body.data` |
| Claims | `POST /agent/reports/claims` | `body.data` |
| Patients | `POST /agent/reports/patients` | `body.data` |
| Appointments | `POST /agent/reports/appointments` | `body.data` |
| Operations | `POST /agent/reports/operations` | `body.data` |

The matching `/agent/insight/*` routes remain as backward-compatible aliases and require the legacy `agent:insight` scope. New credentials and workflows should use only `agent:report` and `/agent/reports/*`.

All routes accept the same strict JSON body:

```json
{
  "period": "last_30_days",
  "compare": "previous_period"
}
```

Periods: `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `last_30_days`, `this_quarter`, `last_quarter`.

Comparisons: `none`, `previous_period`, `previous_week`, `previous_month`, `previous_quarter`, `year_over_year`.

Unknown properties are rejected. In particular, a workflow cannot submit `practiceId`, `tenantId`, or `organisationId`. Dates are resolved in the configured practice timezone. SQL ranges use an inclusive start and exclusive end; public `from` and `to` dates are inclusive.

Successful responses use this envelope:

```json
{
  "success": true,
  "data": {},
  "meta": {
    "source": "luminary",
    "generatedAt": "2026-09-21T10:00:00.000Z",
    "requestId": "req-123"
  }
}
```

## HMAC signing

Each request must include:

- `x-luminary-key`: the issued credential key ID, such as `lmk_...`
- `x-luminary-timestamp`: Unix time in milliseconds as a decimal string
- `x-luminary-signature`: lowercase hexadecimal HMAC-SHA256

The signing key given to n8n is `SHA256(rawCredentialSecret)` encoded as lowercase hexadecimal. Luminary stores this derived key, not the raw secret.

The signed message is exactly:

```text
<timestamp>.<exact request body bytes>
```

The HTTP method and path are not part of the signature. The JSON must be serialized once, then the same exact bytes must be signed and sent. Reformatting JSON, changing whitespace, or changing the timestamp after signing invalidates the request.

Node.js equivalent:

```js
const timestamp = String(Date.now());
const body = JSON.stringify({ period: 'last_30_days', compare: 'previous_period' });
const signature = crypto
  .createHmac('sha256', signingKey)
  .update(`${timestamp}.${body}`)
  .digest('hex');
```

Timestamps more than five minutes in the past or future are rejected. n8n should not retry a captured signature with a new timestamp; it must re-sign the body.

## n8n setup

For each HTTP Request node:

1. Use `POST` and one canonical route from the table above.
2. Serialize `{ period, compare }` once into a body string.
3. Compute the three HMAC headers from that exact string.
4. Set `Content-Type: application/json` and send the string unchanged.
5. Read the report from `body.data` and retain `body.meta.requestId` for support correlation.

Do not send a tenant identifier. Issue a dedicated credential per practice and store the key ID and signing key in n8n credentials, not workflow source or execution logs.

## Error behavior

| Status | Meaning |
| --- | --- |
| `400` | Invalid period/comparison, malformed JSON, or unknown body property |
| `401` | Missing/unknown/revoked/expired credential, stale timestamp, or invalid signature |
| `403` | Valid credential without the route's required scope |
| `500` | Reporting failed; use `requestId` to correlate server logs |

## Metric support

| Domain | Metric | Status | Source / rule |
| --- | --- | --- | --- |
| Patients | Seen, unique, new, returning | Supported | Completed appointments; new means first completed visit occurs in range |
| Patients | Busiest/quietest day, average per active day | Supported | Completed appointment activity date |
| Appointments | Scheduled, completed, cancelled, no-show | Supported | Appointment status in range |
| Appointments | Completion/cancellation/no-show rates | Supported | Status count divided by scheduled count |
| Appointments | Average lead time | Supported | Scheduled appointments with valid creation/start timestamps |
| Appointments | Booked capacity | Unsupported (`null`) | No complete durable capacity ledger |
| Revenue | Billed/outstanding by currency | Supported | Invoice ledger |
| Revenue | Net collections and method breakdown | Supported | Canonical billing collections summary, including reversals and FX rate |
| Revenue | Receivables aging | Supported | Canonical billing liability, payment, adjustment, and denial-transfer formulas |
| Claims | Counts, values, outcome rates | Supported | Canonical claim statuses selected by `submitted_at` |
| Claims | Processing duration, rejection categories | Supported | Completed timestamps and aggregate rejection codes |
| Operations | Wait, consultation, total visit duration | Supported where timestamps exist | Arrival and appointment status history |
| Operations | Delayed visits | Supported | Wait greater than 30 minutes |
| Operations | Bottleneck classification | Unsupported (`[]`) | Management thresholds are not configured |

Money is grouped by currency and never summed across currencies. Collection totals are net of reversals. Aging buckets are `current`, `1-30`, `31-60`, `61-90`, and `90+`, split by responsibility. Undefined denominators and zero comparison baselines return `null` percentages, never `NaN` or infinity.

## Privacy and tenancy

The verified credential supplies the practice ID. Every request runs in a `withTenant` transaction, and report SQL also includes `practice_id = luminary.current_practice_id()` as defense in depth. Responses contain aggregates only: no names, patient identifiers, contact details, diagnoses, notes, prescriptions, documents, or claim-level rows.

Successful access writes an audit event with credential ID, route domain, scope, resolved period, comparison, and request ID. Secrets, signatures, report payloads, and patient data are not logged.

## Ask Luminary bridge

The browser-facing `POST /ai/ask-luminary` route remains separate. It requires an authenticated user with `exportReports`, derives the practice from the session, and forwards the question to that practice's configured n8n webhook. Its structured response supports `answer`, `sources`, `conversationId`, `reportingPeriod`, bounded comparison `metrics`, narrative `sections`, and `followUps`; arbitrary HTML is rejected.

## Verification

Run:

```bash
npm run typecheck
npm run lint
npm run test:insight
npm run verify:integration
npm run verify:executive-insight
```

The database-backed verifier expects the local demo API on `http://127.0.0.1:4001` unless `EXECUTIVE_INSIGHT_BASE_URL` is set. It creates short-lived credentials, calls all six reports, checks both scope families, bad/stale signatures, tenant-selector rejection, response PII keys, and report-query isolation, then soft-deletes its credentials.

The current local demo Compose database is initialized with `luminary_app` as its PostgreSQL bootstrap superuser. PostgreSQL superusers bypass RLS even on `FORCE ROW LEVEL SECURITY` tables, so the verifier tests the report repository's explicit tenant predicates. Production must run the API as the intended non-owner, non-superuser `luminary_app` role so RLS supplies the second database-enforced boundary.
