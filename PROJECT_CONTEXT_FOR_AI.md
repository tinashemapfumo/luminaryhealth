# Luminary Health — System Context for an AI Model

Purpose of this file: give a language model everything it needs to reason correctly
about this repository without re-reading it — what the system is, how it is shaped,
what is genuinely implemented, what is simulated, and what is planned. Where a claim
is aspirational it is marked as such, because the single biggest failure mode when
working on this project is treating demo-mode behaviour as production behaviour.

---

## 1. What the product is

Luminary Health is a **multi-tenant practice management system (PMS) for healthcare
practices in Zimbabwe**, with an intended reach into international/private claims.
It is not a dashboard or a demo app; it is an enterprise clinical + revenue system
covering the whole operational loop of a clinic:

registration → scheduling → clinical encounter → coding → invoice → claim →
adjudication → payment → reporting, with audit, messaging and an AI layer across it.

Two deployment shapes, one codebase:

- **Cloud node** — the hosted API a practice normally uses.
- **Local practice node** — the same server running inside a clinic, so the clinic
  keeps working when the internet drops, and reconciles afterwards by bidirectional
  replication.

Nothing in `src/` knows which one it is beyond stamping `origin_node`. The difference
is four environment variables.

Target market realities that shape the design: unreliable connectivity, dual-currency
cash (USD + local), medical-aid claims through the **NH263** switch with biometric
member verification, and practices that also email claim packs to international
insurers.

---

## 2. Repository layout

```
Luminary Health/
├── luminary-server/            Fastify + TypeScript + PostgreSQL 16 API
├── luminary-frontend-project/  React + Vite + Tailwind workspace client
└── *.md                        product/architecture decision docs (see §8)
```

There is **no git repository** at the root.

### 2.1 Server (`luminary-server`)

```
db/migrations/   001..021 (see §3.4)
scripts/         migrate.ts, seed-passwords.ts, contract-permissions.ts
src/
  app.ts         module registration — the only file that knows all modules
  main.ts        listen + graceful shutdown
  platform/      config, db, errors, http, permissions, session
  modules/       access agent audit auth billing catalogue claims clinical
                 integrations messaging organisation patients scheduling
                 settings sync
```

Every module is `routes → service → repository`. **Modules never import another
module's repository** — that rule is what makes this modular rather than foldered.
Routes validate and delegate; services hold rules; repositories hold SQL. Because no
business logic lives in a route, the sync worker and scheduled jobs reuse services
without inheriting anything HTTP-shaped.

### 2.2 Frontend (`luminary-frontend-project`)

```
src/
  App.jsx                 session gate: login / lock screen / workspace
  config/permissions.js   PERMISSIONS + roleAccess matrix — deliberately import-free
  config/access.js        nav items, patient-file tabs, re-exports the matrix
  services/               index.js (endpoint contract), api.js, patients.js,
                          liveWorkspace.js
  lib/                    access, money, router, workspace context, persistence,
                          format, catalogue, tariffs, orders
  data/                   seed domain data (registry, patientRecords, encounters,
                          scheduling, billing, clinical, engagement, intelligence,
                          reporting, catalogue, tariffs, orders, episodes,
                          practiceSettings, organisation)
  components/             LuminaryDemo.jsx (shell), PatientFile, EncounterNote,
                          ScheduleCalendar, LoginScreen, ui.jsx
  components/pages/       Dashboard, Patients, Appointments, Clinical, Orders,
                          Claims, Billing, Communications, Reports, AI, Audit,
                          Settings, TariffImport
scripts/                  inline-standalone, verify-tokens, verify-money,
                          verify-render, verify-header-menus, verify-live
```

---

## 3. Server architecture — the load-bearing decisions

An AI editing this codebase must preserve these. They are not stylistic.

### 3.1 Tenancy is enforced by PostgreSQL, not by application code

Every tenant table carries `practice_id` and a **row-level security** policy keyed on
a transaction-local session variable. A query that forgets its tenant filter returns
**zero rows**, not another clinic's patients — fail-closed.

- The API connects as `luminary_app`, **which owns nothing** (Postgres exempts a
  table's owner from its own RLS).
- Every table is additionally `FORCE ROW LEVEL SECURITY`.
- There is exactly **one** way to reach the DB from a request: `withTenant()`, which
  opens a transaction and sets the context. `withoutTenant()` exists for sign-in,
  migrations and the sync worker, and is named to be conspicuous in review.
- **Never point `DATABASE_URL` at a superuser or a `BYPASSRLS` role.** RLS silently
  stops applying and one practice sees another's patients with nothing in the log.
  Migrations are the exception and run as `luminary_migrator`; the API may not alter
  its own schema.

This was chosen because application-layer filtering leaked three separate times
during frontend work while the access-checking *functions* were all correct.

**Exactly three operations legitimately precede tenancy**, and all three are
`SECURITY DEFINER` functions taking a hash and returning at most one row:
`resolve_session`, `resolve_invitation`, `password_policy`. That is the complete list
of cross-tenant reads in the system. Sign-in itself needs no hole: the caller names
the practice, the transaction is scoped to it, and the password check still must pass.

### 3.2 Audit is append-only because the database says so

`luminary_app` has `INSERT` and `SELECT` on `audit_event` and nothing else; triggers
refuse `UPDATE`/`DELETE` regardless of caller. Actor identity is written by a
`SECURITY DEFINER` function from the session, **never from the request body**.

Consequence to respect: break-glass, role changes and chart access derive their entire
force from being recorded. A failed unlock attempt must still leave an `alert` entry —
which required restructuring the transaction, since throwing inside `withTenant` rolls
back. The transaction records what happened and returns normally; the refusal is
raised after commit.

### 3.3 Every table is sync-ready from day one

- UUID primary keys a local node can mint unaided.
- `updated_at`, `origin_node`.
- **Tombstones instead of hard deletes** — a shared trigger raises on `DELETE`,
  because a row that vanishes is indistinguishable from one that never arrived.
- `sync_change` is appended **by trigger inside the same transaction** as the write it
  describes, so a change can never replicate inconsistently with its row.
- `sync_conflict` surfaces disagreements to a human rather than resolving silently.
- Exclusion constraints on `appointment` refuse overlapping visits per provider and
  per room — real constraint enforcement, not an application pre-check, because two
  reconnecting nodes genuinely will both book the same slot.
- A signed `encounter` is frozen by trigger; corrections append as addenda.
- Foreign keys are **deferrable**, because a replication batch cannot always be ordered
  to satisfy them.

### 3.4 Migrations 001–021

```
001 foundation            002 identity              003 patients & access
004 clinical & billing    005 audit                 006 auth boundary
007 invitation boundary   008 deferrable constraints 009 replication echo
010 origin per change     011 messaging             012 dispatch lookup
013 backfill              014 receptionist role     015 balance adjustments
016 catalogue/tariffs/orders 017 integrations       018 agent conversations
019 patient documents     020 clinical workflow     021 canonical claims
```

### 3.5 Auth and authorisation posture

- Authentication is a `onRequest` hook → a new endpoint is **authenticated by default**.
- Authorisation is the opposite — declared **per route** — so an endpoint with no
  permission decision is conspicuous rather than quietly permitted.
- Sessions are stored **SHA-256 only**; a dump of the table cannot be replayed.
- Status-code semantics are deliberate and must be preserved:
  - `401` = no/invalid/revoked session (send the user back to sign-in)
  - `403` = "I know who you are, and no"
  - `404` (never `403`) for cross-tenant reads — `403` would confirm existence
  - `428 break_glass_required` names the patient and invites a reason
- Sign-in failures are indistinguishable across wrong password / wrong practice /
  unknown user — no enumeration.
- `GET /practices` is public by necessity (the sign-in picker) and returns **name and
  city only**.
- CORS: `WEB_ORIGINS` is an explicit allowlist with **no wildcard**; the API is
  credentialed and a node that only talks to its peer should allow none.

### 3.6 Permissions are duplicated on purpose

`luminary-server/src/platform/permissions.ts` mirrors
`luminary-frontend-project/src/config/permissions.js`. The client copy decides what to
**draw**; the server copy decides what is **allowed**. Sharing one module would invite
treating one check as covering both, and hiding a button is not access control.

Drift is asserted, not intended: `npm run contract:permissions` compares
**5 roles × 27 permissions = 135 cells**, reads the frontend file directly, and reports
which side disagrees. This is why the matrix was extracted out of `config/access.js` —
that module imports icon components, and a question about a lookup table should not
require React and a bundler to answer.

Roles: `admin`, `doctor`, `nurse`, `manager`, `receptionist`. Receptionist covers
front-desk work (registration, demographics, cover, scheduling, check-in, payments,
claims, biometric capture, patient messaging) and explicitly **not** clinical notes,
prescribing, reports, audit review, AI administration, or system configuration.

### 3.7 Replication — verified between two live nodes

A local node seeds itself then streams:

- On first cycle it copies the practice's current rows, records the peer's change-log
  watermark **read once before the rows and held for the whole run**, and streams
  forward from there. A row edited mid-copy is covered twice; newer-wins settles it.
  Re-reading the watermark per table would advance past those edits and lose them.
- Paged by `id`, not offset (rows are being written during the copy).
- Nothing is marked complete until every table lands; a repeat is harmless (upserts).
- Logging is suppressed while seeding, or a seeded node's first act would be to queue
  the peer's entire database back at the peer.
- `sync_peer.backfilled_at` records that it happened; `NULL` means never seeded.
- **The practice row cannot arrive this way** — it *is* the tenant. A node is
  provisioned with `SYNC_PRACTICE_ID` + node secret and fetches its practice row from
  `GET /sync/identity`. `home_node` is copied as cloud recorded it, never overwritten.
- `authenticateNode` answers *which* practice a peer may speak for from data: a peer
  may only name a practice whose `home_node` is that peer. Foreign practice and
  unknown node both return the same `401` as a bad secret.

Verified result on a fresh node: `seeded: 88`, identical row counts across 19 tables,
`0` rows of the other practice, `0` outbox echo, correct watermark, no second seed on
restart.

**Known open gap:** the seed transfers rows, not attachments, and is a full copy rather
than resumable — a large practice on a bad line restarts from the top.

### 3.8 Bug classes already found here (do not reintroduce)

These were all found by running the system, not by reading it:

1. `seq` is `bigserial` → node-postgres returns a **string**; `z.number()` rejected
   every push.
2. `practice_settings` is keyed on `practice_id`, so blanket `ON CONFLICT (id)` matched
   no constraint.
3. Immediate FK checks aborted whole batches → FKs made deferrable.
4. **Replication echo** — applying a peer's change fired the change-log trigger,
   producing 39 phantom conflicts out of 96 rows.
5. `origin_node` recorded creation only, so cloud edits to clinic-originated rows were
   never sent back — silently, with both sides reporting success.
6. Sequence-space confusion — only a *pull* may be acknowledged; the two nodes keep
   independent counters.
7. `jsonb` columns holding arrays: a JS array becomes a Postgres **array literal**,
   correct for `patient.allergies` (`text[]`), fatal for `encounter.diagnoses`
   (`jsonb`). `writeRow` now looks up declared types (cached per table) and casts.
8. A node could name any practice (see §3.7).
9. SQLSTATE mistranslation: the immutability trigger raises `restrict_violation` =
   **`23001`**, not `2F004`; a correct refusal surfaced as a `500`.
10. Lost `$` on parameter placeholders — `LIMIT $2` became `LIMIT 2`.

---

## 4. Frontend architecture

### 4.1 Two modes, decided at build time by `VITE_API_URL`

- **Unset** → seeded demo: in-memory, `localStorage`-backed. The standalone single-file
  build is always this.
- **Set** → live against `../luminary-server`, with the server owning authentication,
  tenancy, chart access and the audit trail.

**Wired to the API today:** sign-in, session restore, idle lock, patient registry,
chart access including break-glass, registration, chart edits, practice administration.

**Still reading seed data in both modes:** appointments, encounters, billing, claims,
messaging, audit view. The endpoints exist and are tested; the shell has not been moved
onto them.

### 4.2 State model

`LuminaryDemo.jsx` is the shell: state, actions, chrome, routing, dialogs. It came down
from **4,042 lines** to the shell alone and has grown back to ~1,900; the next thing to
extract is the dialog set.

Pages are views over a **workspace context** (`lib/workspace.jsx`), not prop-drilled.
The shell publishes one value — signed-in user, tenant-scoped collections, actions —
and each page destructures what it needs. It is deliberately **not** a state container:
state stays in the shell, so when mutations move behind the API only the shell changes.

The registry (`patientRows`) is the index; `patientRecords` holds full charts.
Appointments, invoices, claims and messages reference patients **by name**, so nothing
is invented locally. Dashboard metrics come from `buildMetrics()` at render, so tiles
cannot drift from the tables beneath them.

### 4.3 Persistence (demo mode)

`lib/persistence.js` writes the workspace through to `localStorage`, versioned and
namespaced (`luminary:v1:*`). Every access is guarded — `localStorage` throws in private
mode, at quota, and when site data is blocked — and degrades to in-memory with one
console warning; a corrupt payload falls back to seed. A schema change bumps the
version and drops the old payload rather than half-reading it. "Reset demo data" in the
user menu clears everything and reloads.

It is a stand-in for the server, **not a design for it**: all tenants share one
namespace because scoping happens at read time, whereas a real backend scopes in the
query. The audit log mattered most here — an append-only compliance record that resets
on F5 creates false assurance.

### 4.4 Routing

`lib/router.js` is a ~60-line **hash** router. Hash, not History API, for two concrete
reasons: the standalone build runs from `file://` where `pushState` throws
(null origin), and hash routes need no server rewrite rules so `dist/` drops onto any
static host. The URL is a **projection** of view state, not a second source of truth —
`buildRoute()` derives the path, a `hashchange` listener applies it back, and an
`appliedRoute` ref stops the two directions chasing each other.

Selecting a different row *within* a view **replaces** the history entry rather than
pushing. Restricted deep links fall back to the overview and correct the URL rather
than rendering blank. Unknown ids are ignored. `document.title` tracks the route.

### 4.5 Scheduling calendar

A real time grid, not a list: time down, resources across. Three views share one grid —
Day (provider columns), Rooms (room columns), Week (weekday columns). Appointments are
absolutely positioned from start + duration, so a 45-minute visit is visibly longer than
a 30-minute one — the entire point over a list is seeing the gaps. Overlaps pack into
lanes so none is hidden. Drag to reschedule (parent owns the rules; a clash is refused
with a toast naming the conflict), click an empty slot to book prefilled, conflicts
detected on shared provider *or* room by real interval overlap, colour = check-in
status, a red current-time line updates every minute, and permissions apply (no
`scheduleVisit` → nothing draggable; `ownPatientsOnly` → one column).

`day` is an offset from today (0 = today); everything meaning "today" reads
`todaysSchedule`.

### 4.6 Patient file

Full-workspace chart, seven tabs — Summary, Demographics, Clinical, Cover & consent,
Visits, Billing, Documents — over a banner with identity, cover, and a deliberately loud
allergy strip that distinguishes *"no known allergies"* from *"nobody has asked yet."*
~45 fields per record.

**Record completeness** is the organising idea: twelve `REQUIRED_FIELDS` define a
complete file, `recordCompleteness()` returns a percentage plus the exact missing list,
the chart shows an amber bar with a *Complete now* link, and the registry carries a
completeness column so gaps are visible without opening anything.

### 4.7 Design system

Every colour, size and radius comes from a named scale in `tailwind.config.js`; a
component may not name a value the scale lacks, and `npm run verify:tokens` fails the
build if one appears. Type: eight steps (10/11/12/13/15/17/20/26, size only — no paired
line-height, because stamping one on a dense clinical table is a separate decision).
Radius: three (4 / 6 / 8px), with `rounded-full` kept where the shape carries meaning.
Colour: **41 names in five families** — ink/text, surfaces, lines, brand, semantic —
each semantic tone carrying fill, hairline and label values so a pill, a calendar block
and a progress bar read as one family. The dark sidebar has its own `shell` ramp,
because text on ink needs different values from text on white. Inter throughout, with
`tabular-nums` on tables.

### 4.8 Verification scripts

| Command | What it proves |
|---|---|
| `npm run verify` | everything below, in order, then the build |
| `verify:tokens` | no colour/size/radius outside the design scale |
| `verify:money` | dual-currency rules match what the server enforces |
| `verify:render` | renders as all 11 seeded users; no cross-tenant output |
| `verify:menus` | real clicks through jsdom over the header menus |
| `verify:live` | real client modules against a running API |

Every component extraction was verified by re-rendering as every seeded user and
comparing output **byte-identical** before and after.

### 4.9 The service contract

`services/index.js` names every mutation the workspace performs and the endpoint that
implements (or will implement) it — **50 operations across 11 groups**: auth, patients,
appointments, encounters, billing, claims, messaging, users, settings, access, audit.
Read as a table, it is the frontend/backend contract: building the frontend first
discovered the domain model, and this writes it down so the server implements it rather
than reinventing it. It also states the three rules the client cannot enforce — tenant
scoping belongs in the query, permissions are re-checked server-side, and audit writes
come from the authenticated principal, never a request field.

---

## 5. Modules and what each does

| Module | Function |
|---|---|
| **Overview** | Live operational metrics, today's schedule, care coordination queue, AI briefing |
| **Patients** | Sortable registry with search and record-completeness, opening a full chart |
| **Appointments** | Day/week/rooms calendar, drag-to-reschedule, click-to-book, check-in progression |
| **Clinical** | Care coordination queue, daily plan, SOAP notes with sign/addendum lifecycle, vitals, prescribing |
| **Orders** | Lab/radiology-style ordering surface (migration 016/020) |
| **Claims** | NH263 biometric claims switch plus an Email claims module — eligibility, capture, submission, adjudication |
| **Billing** | Invoices, service lines with tariff codes, patient responsibility, receipting in either currency, reversals |
| **Communications** | Message log, reminder campaigns, template library |
| **Reports** | Revenue trend, no-show analysis, provider productivity, payer mix, CSV export |
| **Luminary AI** | Agent manager, smart analytics feed, Ask Luminary assistant |
| **Audit log** | Append-only access record — who opened what, on what grounds |
| **Settings** | Practice profile, hours, users, roles, integrations, sync health |
| **Tariff import** | Bulk tariff/catalogue ingestion |

---

## 6. Domain rules the system actually enforces

These are proved over HTTP against a running API, not merely intended.

**Clinical**
- Overlapping booking, same provider → `409` from the exclusion constraint.
- `booked → completed` refused; only `checked_in`, `no_show`, `cancelled`.
- Signing an incomplete note is refused **naming each missing SOAP section**, and
  requires at least one diagnosis.
- Editing a signed note → `409` directing to an addendum; original text unchanged.
  An addendum sets status `amended` with the assessment intact.
- Nurse may draft a note but **not** sign it — drafting and signing are separate grants.
- Prescribing against a recorded allergy is **blocked, naming the allergy**.
- Lapsed clinician registration blocks signing and prescribing.
- A manager reading a clinical note → `403`.

**Money (dual currency, mirrored client and server)**
- Overpayment refused, naming the outstanding amount.
- Paying USD against a ZWL invoice with **no rate** is refused.
- 2 USD at 32.5 applies as 65 ZWL, status `part_paid`, receipt states both.
- Reversal is a **counter-entry** (−70), status returns to `part_paid`; reversing the
  same payment twice is refused.
- Patient balance is **re-derived from the ledger**, never incremented in place.
- A scheme rate change 90% → 80% bills the next invoice 20% to the patient.

**Access and administration**
- An admin cannot change their own role or deactivate their own account.
- Deactivating a clinician with unsigned notes is refused, naming the count.
- Reassigning a patient list is audited and names both clinicians.
- Invitation tokens are issued once, stored as SHA-256 only, and cannot be reused; an
  8-character password is refused citing the practice's own 12-character policy.
- Break-glass **cannot be pre-minted by an admin** — it must be self-taken with its
  alert.
- Manager may read the audit log (*who accessed what* is theirs) but not note contents.
- Doctor may read settings but **without integration identifiers**.

**Claims and messaging**
- Biometric capture moves a draft to `biometric_verified` with an audit notice.
- Submit from `draft` or `biometric_verified` → `submitted` with timestamp/reference.
- Adjudication records approved/paid/rejected; rejection requires a code.
- Submitting an already-adjudicated claim is refused.
- A queued message may be cancelled while queued; a sent or failed one may not.

---

## 7. The canonical claims model (migration 021)

This is the newest and most structurally significant subsystem. Luminary owns a
**canonical claim**, and every submission channel is an adapter over it.

Tables: `claim`, `claim_line`, `claim_diagnosis` (kept **separate from encounter
diagnoses** so billing staff can correct claim coding without rewriting clinical notes),
`claim_event` (immutable timeline), `claim_transmission` (outbound/inbound exchanges),
`claim_adjudication` (normalised payer responses), `claim_attachment` (references
existing `patient_document` rows). Remittance, eligibility and prior-authorisation
structures exist for later work.

The adapter contract is `src/modules/claims/claims.types.ts`:

```ts
type SubmissionChannel = 'NH263' | 'EMAIL_PDF' | 'MANUAL';

interface ClaimsAdapter {
  key: SubmissionChannel;
  validateClaim(claim): ClaimValidationResult;          // errors + warnings
  submitClaim(client, claim, snapshot): Promise<NormalizedSubmissionResult>;
  getClaimStatus(client, claim): Promise<NormalizedSubmissionResult>;
  mapOutboundClaim(claim): unknown;
  mapInboundResponse(response): NormalizedSubmissionResult;
}
```

Current adapters: `ManualClaimAdapter`, `EmailPdfClaimAdapter`, and a **deliberately
skeletal** `NH263Adapter`.

> **Critical instruction for any AI working here:** the NH263 adapter **must not invent
> endpoints or payload fields.** It stays skeletal until official NH263 documentation
> and credentials exist. `NH263_INTEGRATION_REQUIREMENTS.md` lists ~28 facts still
> required from NH263 (sandbox/production URLs, auth method, payload schema, tariff
> format, ICD-10 linkage rules, membership verification, biometric spec, eligibility,
> prior-auth, attachments, status endpoint, webhook signature protocol, adjudication
> schema, error-code catalogue, remittance format, idempotency, certification/UAT, IP
> allow-listing/mTLS, rate limits, retry/backoff).

Claim submission creates an **immutable snapshot**, so later edits to patient, provider,
tariff or diagnosis data do not rewrite what was actually submitted. NH263 callbacks
exist only as a placeholder route until the verification protocol is known.

---

## 8. The planning documents (root `*.md`)

| Document | What it decides |
|---|---|
| `GO_LIVE_REQUIREMENTS.md` | The hard blocker checklist: env, non-superuser `DATABASE_URL`, all migrations incl. 019, `/health`, production `VITE_API_URL`, `WEB_ORIGINS`, real tenant data, `verify:live` passing, RLS verified with the app role, TLS, tested backup **and restore**. Plus clinical, file-storage, financial/claims, communications and security/compliance sections. |
| `NH263_INTEGRATION_REQUIREMENTS.md` | The adapter boundary and the list of facts still owed by NH263. |
| `INTERNATIONAL_EMAIL_CLAIMS_WORKFLOW.md` | Email claims as a **first-class channel**, not an exception inside the NH263 flow. |
| `VARIABLE_PRICING_WORKFLOW.md` | Pricing that is not a fixed tariff. |
| `BILLING_PAGE_STRUCTURE.md` | The practice-wide vs patient-account split. |
| `ZIMBABWE_CUSTOMER_RISK_AND_UPSIDE.md` | A skeptical local buyer's objections. |

### 8.1 Email claims workflow (design → partially built)

Flow: staff prepares the claim form from existing patient/invoice/diagnosis/tariff/
provider data → Luminary records the provider-specific form and document checklist →
a **secure review link** goes to the client → the client reviews, accepts the
declaration, and authenticates by OTP or portal login → Luminary **locks the claim pack
and records the authentication evidence** → staff emails the pack to the insurer →
Luminary tracks submission reference, follow-up date, replies, queries, outcome, payment.

Extra statuses beside the switch statuses: `Form prepared`, `Awaiting client
authentication`, `Client authenticated`, `Email submitted`, plus
`submissionChannel: "Email"` so these filter independently.

**Authentication boundary (a rule, not a preference):** staff may prepare the form on
behalf of the client but **must not sign or approve it as if they were the client**.
Generated packs say: *"Prepared by Luminary Health on behalf of the member. Reviewed and
authorised by the member before submission."* Evidence retained: declaration checkbox,
OTP verification, timestamp, claim version/hash or locked PDF reference, client identity
reference — retained **with the claim**, because email gives no delivery proof.

Built today: a front-end `Email` module on the Claims page covering prepare → send to
client → record authentication → submit, as a **persisted front-end simulation**.
Still owed by the backend: provider email config, PDF generation/form filling, secure
client review portal, OTP service, immutable pack versioning, email gateway (M365 /
Google Workspace / SMTP), inbound email matching to claim/member/invoice, audit entries
for preparation/authentication/submission.

### 8.2 Variable pricing (design → front-end built)

The **invoice line is the final billing truth**. A catalogue service may supply a
standard price, but the saved line records the final confirmed amount. Model: typed
service description (required) → optional catalogue match → pricing mode → final price
with override context → claim/receipt/statement/reports all derive from the invoice.

Modes: `Standard price` (locks the amount), `Adjust standard price` (starts from
catalogue, edit allowed, **reason required**), `Custom price` (manual entry, **reason
required**).

Stored whenever the amount is not standard: standard amount, final amount, pricing mode,
reason, optional note, capturing user, timestamp. Reason list: consumables used,
procedure complexity, extended consultation, after-hours, provider discretion,
contracted client rate, other.

Built today: the invoice modal (required typed description, optional catalogue dropdown,
pricing dropdown, standard-price display, editable amount, reason capture), pricing
metadata saved on lines, and the override reason shown in Billing detail. **Front-end
only** — production must enforce the same validation server-side and record price
changes in the audit log.

### 8.3 Billing page structure (design → front-end built)

Billing does two different jobs — practice-wide finance control and patient-specific
account work — sharing the same data but **not the same layout**. Chosen structure
("Option 3"): sidebar Billing has tabs `Overview`, `Accounts`, `Invoices`,
`Claims exposure`, `Receipts`. Opening a patient account shows only that patient's
records; other patient names are hidden until you go back.

Inside a patient file, the Billing tab shows patient totals, invoices, payments and
claims, and **must not** show practice-wide queues, other patient names, global aging
buckets, or global claims exposure.

Statement is a ledger: invoices debit, payments credit, reversals debit, write-offs and
credits credit, each row carrying a running balance. **Patient responsibility and
insurer exposure stay separate** — patients are not chased for insurer portions unless
the claim is rejected or the amount is deliberately moved to patient responsibility.

---

## 9. Honest maturity map

Treat this as the authoritative answer to "is X real?"

| Area | Reality |
|---|---|
| Postgres schema, RLS, audit immutability, tombstones, constraints | **Real and verified** against PostgreSQL 16 |
| Auth, sessions, break-glass, invitations, roles | **Real**, verified over HTTP |
| Patients, scheduling, clinical, billing, organisation, access, settings, audit, sync, messaging (server) | **Real**, eleven modules end to end |
| Bidirectional replication + node seeding | **Real**, verified between two live nodes |
| Permission contract (135 cells) | **Real**, asserted by test |
| Frontend live wiring | **Partial** — sign-in, session restore, idle lock, registry, chart access/break-glass, registration, chart edits, practice administration |
| Frontend appointments, encounters, billing, claims, messaging, audit view | **Seed data in both modes** — endpoints exist and are tested, shell not yet moved onto them |
| Claims lifecycle | **Internal surface real**; the external switch is not connected |
| NH263 switch | **Not connected.** Skeletal adapter awaiting official docs/credentials |
| Email claims | **Front-end simulation**; backend pack/OTP/gateway not built |
| Variable pricing | **Front-end only**; server-side validation + audit still owed |
| Payment gateways | Not connected |
| SMS / WhatsApp / email delivery | Queue, list and cancel are real; **delivery sits behind the dispatcher seam** (n8n/carrier webhook not wired) |
| AI agents / Ask Luminary | Surfaces exist (`agent` module, migration 018); **execution not wired**, feed content is seeded |
| Document upload/download | Migration 019 exists; go-live requires storage path, encryption, backups, malware scanning |
| ZiG/ZWG currency, ZIMRA fiscalisation | **Not built** — named as buyer blockers |

---

## 10. Known risks and open questions

From the code, and from `ZIMBABWE_CUSTOMER_RISK_AND_UPSIDE.md`:

1. **Not production-ready** until the go-live blockers close and `verify:live` passes
   against a real tenant.
2. **NH263 is presented more confidently than the implementation supports** — the UI can
   read "NH263 switch · Connected" while submission and adjudication are internal
   placeholders. This is a trust problem, because claims are the buying trigger.
3. **Currency language is stale** — the app models USD/ZWL; the market expects ZiG/ZWG,
   exchange-rate history, and accountant-defensible rate selection.
4. **ZIMRA fiscalisation is absent** — no fiscal tax invoice, device integration, FDMS,
   fiscal receipt reference, or VAT/BP fields. Potentially a hard blocker on its own.
5. **Privacy posture needs to be explicit** — hosting location, backup access, consent
   and withdrawal, disclosure, retention, breach handling, audit review ownership, and
   biometric data protection should become a formal compliance pack.
6. **Demo data undermines local credibility** — generic US-style names, `clinic.io`
   emails and CVS pharmacy references in a product framed around Zimbabwe. The fix is
   not cosmetic: local names, suburbs, medical-aid behaviour, pharmacy/lab/radiology
   patterns, payment methods, and realistic claim failures.
7. **AI surfaces overpromise** — agents shown booking, preventing rejections, recovering
   debt and forecasting, without live audited execution behind them.
8. **Data residency** — whether Zimbabwean law permits health records offshore decides
   cloud vs in-country hosting. The code is deployment-agnostic, so the answer changes
   configuration rather than architecture, but it should be answered before production.
9. **Secrets** — `practice_settings` holds NH263 and gateway *identifiers* only. Secrets
   belong in a secret store, write-only from the API, never returned to a browser.
10. **Sync seeding** does not transfer attachments and is not resumable; per-table resume
    is the obvious next increment now that `backfilled_at` gives it somewhere to record
    progress.
11. `LuminaryDemo.jsx` has grown back to ~1,900 lines; the dialog set is the next
    extraction.

---

## 11. Running it

**Server**
```bash
npm install
cp .env.example .env      # DATABASE_URL (as luminary_app, NOT a superuser), NODE_ID
npm run migrate           # runs as luminary_migrator
npm run dev
npm run contract:permissions
```

Local practice node adds only:
```bash
NODE_ID=harare-central-local
SYNC_PEER_URL=https://api.luminaryhealth.co.zw
SYNC_SECRET=...
SYNC_PRACTICE_ID=...
WEB_ORIGINS=http://localhost:5173     # comma-separated, no wildcard
```

Sanity check before trusting RLS — both flags must read `f`:
```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

**Frontend**
```bash
npm install
npm run dev                # http://localhost:5173/
npm run build              # dist/
npm run build:standalone   # single-file Luminary-Health.html, runs from file://
npm run verify             # lint, tokens, money, render, menus, build
npm run verify:live        # needs LUMINARY_API/PRACTICE/EMAIL/PASSWORD
```

**Demo sign-in** — practice *Harare Central Clinic*, password `luminary`:
`n.dhlamini@` (receptionist), `m.chen@` (doctor), `s.moyo@` (nurse), `r.chikafu@`
(manager), `t.mapfumo@` (administrator), all `hararecentral.co.zw`. For tenant-boundary
checks: `t.ncube@bulawayofamily.co.zw` at *Bulawayo Family Practice*.

---

## 12. Rules for an AI making changes here

1. **Never weaken the database as the enforcement point.** Tenancy, audit immutability,
   note immutability, appointment overlap and delete-tombstoning live in Postgres on
   purpose. Do not move a check up into application code "for clarity".
2. **Never connect to the database as a superuser or `BYPASSRLS` role**, and never
   suggest it as a workaround for a query returning zero rows. Zero rows is the design.
3. **Do not add a fourth cross-tenant read.** The three `SECURITY DEFINER` functions are
   the complete audited boundary.
4. **Keep the two permission matrices duplicated and in sync**; run
   `npm run contract:permissions` after touching either.
5. **Never import another module's repository.**
6. **Preserve the status-code semantics** in §3.5 — they carry meaning a client depends
   on (`401` vs `403`, `404` for cross-tenant, `428` for break-glass).
7. **Do not invent external protocol details** — NH263 endpoints and payloads, gateway
   callbacks, or webhook signatures. Leave the adapter skeletal.
8. **Do not present unbuilt integrations as connected** in UI copy, docs, or demos.
9. **Audit writes come from the authenticated principal**, never from a request field,
   and must survive a refused operation.
10. **Respect the design token scale** — `verify:tokens` fails the build on a raw value.
11. **Verify by running, not reading.** Every serious bug in this project's history was
    invisible on the page: string `bigserial`, the replication echo, the wrong SQLSTATE,
    the lost `$`, the silently-stopped downstream sync.
