# Luminary Executive Insight v1 - Implementation Report

Date: 2026-09-21  
Status: Implemented and verified against the running local demo API/database

## Outcome

Executive Insight now exposes six stable, read-only aggregate reporting APIs for the n8n Executive Analyst. The canonical contract is `/agent/reports/*` with the least-privilege `agent:report` scope. Existing `/agent/insight/*` consumers remain functional through explicit `agent:insight` compatibility routes.

The reporting API cannot choose a practice, submit SQL, or retrieve row-level clinical or patient data. The verified integration credential determines tenancy, each query includes an explicit tenant predicate, and responses contain aggregates only.

## Delivered routes

| Route | Scope | Purpose |
| --- | --- | --- |
| `POST /agent/reports/executive-summary` | `agent:report` | Cross-domain leadership snapshot |
| `POST /agent/reports/revenue` | `agent:report` | Billing, collections, methods, and receivables |
| `POST /agent/reports/claims` | `agent:report` | Claim volume, outcomes, values, and processing |
| `POST /agent/reports/patients` | `agent:report` | Aggregate patient activity |
| `POST /agent/reports/appointments` | `agent:report` | Appointment volumes, rates, and lead time |
| `POST /agent/reports/operations` | `agent:report` | Throughput and recorded visit timing |

Every route has a matching `/agent/insight/*` alias requiring `agent:insight`. The authenticated browser bridge remains `POST /ai/ask-luminary`.

## Security contract

- HMAC headers are `x-luminary-key`, `x-luminary-timestamp`, and `x-luminary-signature`.
- The canonical signed value is `timestamp + "." + exactRawBody`.
- The algorithm is HMAC-SHA256 with a lowercase hex digest.
- The signing key supplied to n8n is the lowercase SHA-256 hash of the one-time raw credential secret.
- The accepted clock window is five minutes in either direction.
- Credentials must be active, unexpired, and carry the exact route scope.
- The strict request body accepts only `period` and `compare`.
- Practice context always comes from the credential and is passed to `withTenant`.
- Report access uses existing audit infrastructure without logging signatures, secrets, payloads, or patient data.

The complete n8n signing and endpoint mapping is in `docs/executive-insight.md`.

## Reporting behavior

Supported periods:

`today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `last_30_days`, `this_quarter`, `last_quarter`.

Supported comparisons:

`none`, `previous_period`, `previous_week`, `previous_month`, `previous_quarter`, `year_over_year`.

Periods resolve in the practice timezone. Calendar comparisons use complete prior week/month/quarter ranges; previous-period comparisons use the immediately preceding equal duration; year-over-year dates clamp safely around leap years and month boundaries.

Comparison values have a stable shape:

```json
{
  "current": 428,
  "previous": 391,
  "change": 37,
  "changePercent": 9.46
}
```

Missing comparisons and zero baselines return `null` percentages. Currency totals are always grouped and never added across currencies.

## Existing logic reused

Executive Insight does not maintain a second interpretation of collections or receivables:

- Net collections, reversals, payment methods, responsibility buckets, and stored FX rates come from the billing module's shared collections summary.
- Receivables use the billing module's canonical liability calculation, including latest adjudication state, member/insurer liability, payments, adjustments, and denial transfers.
- Aging uses the existing bands: `current`, `1-30`, `31-60`, `61-90`, and `90+`.
- Practice timezone, HMAC credential verification, tenant transactions, errors, audit logging, appointment status history, canonical claims, and invoice/payment ledgers are existing platform capabilities.

The detailed staff collections report still enriches the shared aggregate summary with actors and transaction rows. Executive Insight receives only the aggregate portion.

## Query design

The executive summary resolves its practice clock and date ranges once. It loads each required current/comparison dataset once and composes the result directly, instead of recursively calling five complete reports and repeating appointment, operations, context, payment-breakdown, and aging queries.

Report SQL is parameterized and predefined. There is no dynamic SQL, arbitrary field selector, generic report runner, or database execution endpoint.

## Metric support summary

Supported:

- Patient seen, unique, new, returning, busiest/quietest day, average per active day
- Appointment status counts and rates, plus average booking lead time
- Billed, outstanding, net collected, collection rate, payment method, and canonical receivables aging by currency
- Claim status counts/rates, values, processing duration, and aggregate rejection categories
- Operational throughput, wait time, consultation time, total visit time, and delayed visits where event timestamps exist

Deliberately unsupported:

- Booked capacity is `null` because no complete capacity ledger exists.
- Bottlenecks are `[]` because management thresholds are not configured.
- Missing operational timestamps are excluded rather than estimated.
- Executive targets are omitted because the schema has no authoritative target model.

## Files added

- `src/modules/executive-insight/executive-insight.routes.ts`
- `src/modules/executive-insight/executive-insight.service.ts`
- `src/modules/executive-insight/executive-insight.repository.ts`
- `src/modules/executive-insight/reporting-period.ts`
- `src/modules/executive-insight/reporting-request.ts`
- `src/modules/executive-insight/metrics.ts`
- `src/modules/executive-insight/reporting-period.test.ts`
- `src/modules/executive-insight/ask-luminary.service.ts`
- `src/modules/executive-insight/ask-luminary.service.test.ts`
- `scripts/verify-executive-insight.ts`
- `db/migrations/041_executive_insight_webhook.sql`
- `docs/executive-insight.md`
- `docs/EXECUTIVE_INSIGHT_IMPLEMENTATION_REPORT.md`

## Material files modified

- `src/platform/integration-keys.ts`: added `agent:report` and retained `agent:insight`.
- `src/platform/http.ts`: recognizes both signed route families as machine endpoints.
- `src/modules/billing/billing.repository.ts`: split reusable aggregate collection summary from staff detail and added aggregate canonical aging.
- `src/modules/billing/billing.service.ts`: exposes aggregate reporting adapters.
- `scripts/verify-integration.ts`: validates route scopes, strict schema, tenant source, query scoping, and PII exclusions.
- `package.json`: adds focused test and live verification commands.
- Ask Luminary frontend/services and practice settings: connect the manager UI to the configured practice workflow and render bounded structured answers.

## Verification evidence

Completed successfully:

- `npm run typecheck`
- `npm run lint`
- `npm run test:insight`: 9/9 tests passed
- `npm run verify:integration`: all credential, signature, replay, scope, tenancy-source, and privacy rules passed
- `npm run verify:executive-insight`: all six canonical reports returned 200 and passed envelope/PII checks
- Compatibility `/agent/insight/executive-summary`: returned 200 with `agent:insight`
- Canonical route with legacy-only scope: returned 403
- Invalid signature: returned 401
- Timestamp older than five minutes: returned 401
- Body containing `practiceId`: returned 400
- Actual reporting query under an unrelated tenant context: returned zero appointments
- Rebuilt local API image: healthy on `http://127.0.0.1:4001`

The fixture arithmetic remains covered: 428 versus 391 gives 9.46%, and 22,180 versus 19,410 gives 14.27%.

## Remaining gaps and operational notes

1. The local demo Compose database bootstraps PostgreSQL with `luminary_app` as a superuser. That role can bypass RLS, so the live smoke test validates the report queries' explicit tenant predicates. Production must use the migration architecture's intended non-owner, non-superuser application role for RLS defense in depth.
2. There is no report-specific distributed rate limiter in the current platform. HMAC authentication, five-minute freshness, scope restriction, strict body validation, and global body limits apply. Add gateway or shared-store rate limiting before exposing these routes beyond the trusted integration network.
3. Capacity utilisation, threshold-based bottlenecks, and management targets require authoritative source models before they should be reported.

## Assessment

The implementation is ready for controlled n8n integration. The strongest design choice is that n8n asks for named reports while Luminary owns all SQL and semantics. Reusing billing's collections and receivables calculations also removes the most dangerous class of reporting drift: a dashboard that disagrees with the operational ledger.

The live demo now uses the intended role split. Local Compose and any future staging stacks should be brought to the same standard so PostgreSQL RLS remains an independent boundary everywhere.

## Live demo deployment - 2026-09-21

The implementation was deployed from commit `e0c8ac5` to the existing online-demo container. No parallel API service was created.

| Check | Result |
| --- | --- |
| Public API base URL | `https://api.luminarytech.org` |
| Public health | `GET /health` returned `200` with node `cloud-demo` |
| Migration | `041_executive_insight_webhook.sql` applied at `2026-09-21 18:26:05 UTC` |
| Migration identity | `luminary_migrator` against `luminary_demo` |
| Runtime identity | `luminary_app` against `luminary_demo` |
| Runtime role flags | Non-superuser and no `BYPASSRLS` |
| Ownership | Luminary tables remain owned by `luminary_migrator` |
| Role membership | `luminary_app` no longer inherits `luminary_migrator` |
| Excess privileges | No schema create, patient delete, or patient truncate privilege |
| RLS | No tenant context returned 0 patients; demo context returned its expected 21 |
| Normal application check | Administrator session and `GET /auth/me` succeeded |
| Protected route registration | Unsigned canonical report request returned `401`, not `404` |

The migrator password was rotated and its URL is held in a root-only host file used only for migrations. It is not injected into the API container. A second migration run reported `Already up to date`.

### Provisioned n8n credential

- Practice: `Harare Family Health Demo`
- Practice ID: `33333333-3333-4333-8333-000000000001`
- Key ID: `lmk_KmeQHg9eRz_e`
- Scope: exactly `agent:report`
- Signing key: generated and supplied once to the operator; intentionally omitted here

The temporary `agent:insight` credential used to prove wrong-scope behavior was revoked immediately after the test.

### Public endpoint verification

Using the exact body `{"period":"last_30_days","compare":"previous_period"}`, serialized once and used unchanged for both HMAC input and the HTTP body:

| Endpoint | Result |
| --- | --- |
| `POST /agent/reports/executive-summary` | `200` |
| `POST /agent/reports/revenue` | `200` |
| `POST /agent/reports/claims` | `200` |
| `POST /agent/reports/patients` | `200` |
| `POST /agent/reports/appointments` | `200` |
| `POST /agent/reports/operations` | `200` |

Security checks against the public API:

- Invalid signature returned `401`.
- Correctly signed timestamp older than five minutes returned `401`.
- Signed body containing `practiceId` returned `400`.
- Valid credential lacking `agent:report` returned `403`.
- The six aggregate responses contained no patient-identifying field names.
- Practice selection remained credential-derived.

### Ask Luminary n8n bridge

The production workflow URL is configured per practice through authenticated `PATCH /settings/integrations`:

```json
{
  "executiveInsightWebhookUrl": "https://the-activated-n8n-webhook",
  "executiveInsightWebhookSecret": "a-practice-owned-secret-at-least-16-characters"
}
```

These values are stored in:

- `luminary.practice_settings.executive_insight_webhook_url`
- `luminary.practice_settings.executive_insight_webhook_secret`

The secret is write-only through the API and is never returned by settings reads. The online demo currently has no webhook URL configured; no old URL was present and no temporary URL was inserted.

Luminary sends this exact JSON shape to the configured n8n webhook:

```json
{
  "question": "The manager's question",
  "conversationId": null,
  "requestId": "Luminary request correlation ID"
}
```

It sends `x-luminary-timestamp`, `x-luminary-signature`, and `x-luminary-request-id`. The webhook signature is lowercase hexadecimal HMAC-SHA256 over `timestamp + "." + exactRawBody`, using the per-practice webhook secret.

n8n must return JSON with a required non-empty `answer`. It may also return:

```json
{
  "answer": "Required narrative answer",
  "sources": ["Revenue", "Claims"],
  "conversationId": "optional-workflow-conversation-id",
  "reportingPeriod": {
    "label": "Last 30 days",
    "from": "2026-08-23",
    "to": "2026-09-21",
    "comparisonLabel": "Previous period"
  },
  "metrics": [
    {
      "label": "Collected",
      "value": "USD 22,180",
      "previous": "USD 19,410",
      "changePercent": 14.27,
      "sentiment": "positive"
    }
  ],
  "sections": [
    {
      "title": "What changed",
      "body": "Optional section narrative",
      "items": ["Optional bounded list item"]
    }
  ],
  "followUps": ["Show the payment method breakdown"]
}
```

Only `answer` is required. Luminary validates and bounds every optional field before returning it to the browser.

### Remaining n8n step

The reporting credential and public APIs are ready. The only workflow-specific blocker is importing and activating the production n8n Executive Insight workflow, then writing its production webhook URL and webhook signing secret to the demo practice settings. Until that is done, `POST /ai/ask-luminary` deliberately returns `503 agent_not_configured`.
