# Luminary Health · API

The server behind the Luminary workspace. One codebase, two deployments: the
cloud node, and a local server sitting in a practice that must keep working when
the line drops.

**Status:** **verified running.** Eleven modules work end to end against
PostgreSQL 16: auth, patients, scheduling, clinical, billing, organisation,
access, settings, audit, sync, and messaging. Two nodes replicate bidirectionally.
Claims now have an internal lifecycle surface; remaining external work is the
real NH263 switch/proxy, payment gateways, SMS/WhatsApp carrier delivery, and AI
execution.

---

## Why it is shaped this way

### Tenancy is enforced by the database

Every tenant table has `practice_id` and a row-level security policy keyed on a
transaction-local session variable. A query that forgets its tenant filter
returns **zero rows**, not another clinic's patients.

This is not defensive theatre. While building the frontend, tenant isolation
leaked three separate times — collections that were never scoped, deep links
that bypassed the check, a dashboard panel nobody thought about — and on every
occasion the access-checking *functions* were correct. Application-layer
filtering is one forgotten `WHERE` away from a breach, permanently, on every
query anyone writes in future. Putting the control in Postgres removes that
class of mistake rather than promising to avoid it.

Two details make it real:

- The API connects as `luminary_app`, which **owns nothing**. Postgres exempts a
  table's owner from its own RLS policies.
- Every table is additionally set to `FORCE ROW LEVEL SECURITY`, which closes the
  same hole from the other side.

There is exactly one way to reach the database from a request — `withTenant()` —
which opens a transaction and sets the context. `withoutTenant()` exists for
sign-in, migrations, and the sync worker, and is named to be conspicuous in
review.

### Audit is append-only because Postgres says so

`luminary_app` is granted `INSERT` and `SELECT` on `audit_event` and nothing
else, and triggers refuse `UPDATE` and `DELETE` regardless of who asks. Actor
identity is written by a `SECURITY DEFINER` function from the session, never from
the request body — a client must not be able to choose whose name appears against
an action.

Break-glass, role changes, and chart access are controls whose entire force comes
from being recorded. A trail the writing process can edit is a log file with a
compliance label on it.

### Every table is sync-ready from day one

A practice runs a local server that must survive an internet outage and reconcile
afterwards. That needs UUID primary keys the local node can mint unaided,
`updated_at`, an `origin_node`, and **tombstones instead of hard deletes** — a
row that simply vanishes is indistinguishable from one that never arrived, so the
shared trigger raises on `DELETE`.

`sync_change` is appended by trigger inside the same transaction as the write it
describes, so a change can never replicate inconsistently with its row.
`sync_conflict` surfaces disagreements for a human instead of resolving them
silently; quietly losing a clinical write is the one outcome worse than a
conflict.

Multi-tenancy makes this far more tractable than usual: a local node syncs one
practice's rows, so there is never a cross-tenant merge.

### Constraints that hold under sync

Two nodes reconnecting after an outage will genuinely both try to book the same
slot, so the exclusion constraints on `appointment` refuse overlapping visits per
provider and per room. A signed `encounter` is frozen by trigger — corrections
append as addenda, because an audited record must show what was written and when.

---

## Layout

```
db/migrations/     001 foundation · 002 identity · 003 patients & access
                   004 clinical & billing · 005 audit · 006 auth boundary
                   007 invitation boundary · 008 deferrable constraints
                   009 replication echo · 010 origin per change
                   011 messaging · 012 dispatch lookup · 013 backfill
                   014 receptionist role
scripts/           migrate.ts, seed-passwords.ts, contract-permissions.ts
src/
  app.ts           module registration — the only place that knows them all
  main.ts          listen + graceful shutdown
  platform/        config, db, errors, http, permissions, session
  modules/
    auth/          sign-in, unlock, token resolution, revocation, practice list
    patients/      routes → service → repository          (the pattern)
    scheduling/    booking, rescheduling, check-in progression
    clinical/      encounters, vitals, signing, addenda, prescribing
    billing/       invoices, payments, reversals, aging, claims lifecycle
    organisation/  users, invitations, offboarding, registrations
    access/        cover grants, break-glass review
    settings/      practice configuration and enterprise administration
    audit/         read-only audit access
    sync/          local-to-cloud replication, and seeding a new node
    messaging/     patient messages, queueing, cancellation, dispatcher seam
```

Each module owns `routes → service → repository`, and modules never import each
other's repositories — that rule is what keeps this modular rather than merely
foldered. Routes validate and delegate; services hold rules; repositories hold
SQL. No business logic in a route means the sync worker and scheduled jobs reuse
services without inheriting anything HTTP-shaped.

Remaining: the external NH263 switch, payment gateway callbacks, AI execution,
and the n8n/carrier webhook. Claims already have an internal lifecycle surface,
and messaging has HTTP routes that queue, list, and cancel messages; actual
delivery remains behind the dispatcher seam.

Authentication is a `onRequest` hook, so a new endpoint is authenticated by
default. Authorisation is the opposite — declared per route — because an
endpoint with no permission decision should be conspicuous rather than quietly
permitted.

---

## Permissions are duplicated on purpose

`src/platform/permissions.ts` mirrors `src/config/permissions.js` in the
frontend. That duplication is deliberate: the client copy decides what to
*draw*, this copy decides what is *allowed*. Sharing one module would invite
someone to treat a single check as covering both, and hiding a button is not
access control.

What the duplication must not do is **drift**, so it is asserted rather than
intended:

```bash
npm run contract:permissions   # 5 roles x 27 permissions, 135 cells
```

It fails on a role either side does not have, a permission either side does not
declare, and any cell where they disagree — reporting which way round, because a
client that offers what the server refuses is a broken button, while a client
that hides what the server permits is a feature nobody can reach. It reads the
frontend file directly, which is why that matrix was extracted out of
`config/access.js`: that module imports icon components, and a question about a
lookup table should not need React and a bundler to answer.

It found a real disagreement the first time it ran — `recordPayment` was
enforced here and did not exist in the client copy at all.

Current roles: `admin`, `doctor`, `nurse`, `manager`, and `receptionist`.
Receptionist permissions cover front-desk work: patient registration,
demographics and cover, scheduling, check-in, payments, claims, biometric
capture, and patient messaging. They do not include clinical notes, prescribing,
reports, audit review, AI administration, or system configuration.

---

## Running

```bash
npm install
cp .env.example .env          # set DATABASE_URL and NODE_ID
npm run migrate
npm run dev
```

> **Connect as `luminary_app`, never as a superuser.**
>
> Row-level security is the whole tenancy model, and PostgreSQL exempts
> superusers and any role with `BYPASSRLS` from it — silently. Point
> `DATABASE_URL` at `postgres` and every policy in this schema stops applying:
> one practice sees another's patients, with no error and nothing in the log to
> suggest anything is wrong. `FORCE ROW LEVEL SECURITY` does not help; it
> constrains the table *owner*, not a superuser.
>
> ```sql
> SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
> ```
>
> Both flags must read `f`. Migrations are the exception and run as
> `luminary_migrator`, because the API is not permitted to alter its own schema.

A practice's local server differs only in configuration:

```bash
NODE_ID=harare-central-local
SYNC_PEER_URL=https://api.luminaryhealth.co.zw
SYNC_SECRET=...                                     # scoped to this practice
SYNC_PRACTICE_ID=11111111-1111-1111-1111-111111111111
```

Those four lines are the whole provisioning step. The node fetches its own
practice row, seeds itself from the peer, and streams from there — see
[Bringing up a new node](#bringing-up-a-new-node-snapshot-then-stream).

A browser client needs its origin allowed explicitly:

```bash
WEB_ORIGINS=http://127.0.0.1:5174      # comma-separated; empty means no browser may call
```

There is no wildcard. The API is credentialed, and a node that only ever talks
to its peer should allow none.

Nothing in `src/` is aware of which deployment it is, beyond stamping
`origin_node`. That is what makes the local option viable.

---

## Verification

Everything below was executed against PostgreSQL 16, not merely reviewed.

```bash
docker run -d --name luminary-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=luminary -p 55432:5432 postgres:16
DATABASE_URL=postgres://postgres:dev@localhost:55432/luminary npx tsx scripts/migrate.ts
```

All fourteen migrations apply cleanly. The properties the design rests on were then
proved individually:

| Property | Result |
|---|---|
| Tenant isolation | Harare user sees 2 patients, Bulawayo user sees 1; fetching a foreign id returns 0 rows |
| **No tenant context** | Returns **0 rows**, not everything — fail-closed |
| FORCE RLS vs table owner | Owner in Bulawayo context still sees only Bulawayo rows |
| Audit immutability | `UPDATE` and `DELETE` both refused; row survives |
| Appointment overlap | Second overlapping booking refused by exclusion constraint |
| Signed note immutability | Draft edit succeeds; post-signature edit refused by trigger |
| Hard delete | Trigger raises, directing the caller to `deleted_at` |
| Grant expiry | none → `break_glass` → none, on a patient with no other relationship |
| Change log | Populated by trigger across 7 table/operation pairs |

And over HTTP, against the running API:

| Case | Result |
|---|---|
| Wrong password / wrong practice / unknown user | Identical message, no enumeration |
| Cross-tenant `GET /patients/:id` | `404 not_found` — never `403`, which would confirm existence |
| Own patient | `relationship: primary provider` |
| Unrelated patient | `428 break_glass_required` with the patient named |
| Retry with a reason | Succeeds, `breakGlass: true`, `alert` audit entry written |
| No token | `401` — *not* `403`, so a client can tell an ended session from a refusal |
| Doctor reads the audit log | `403` — session known, role insufficient |

Sessions are stored as SHA-256 only — a dump of the table cannot be replayed.

### Clinical and billing, over HTTP

| Case | Result |
|---|---|
| Overlapping booking, same provider | `409` from the exclusion constraint, not an application pre-check |
| `booked → completed` | Refused: *"only checked_in, no_show, cancelled"* |
| Sign an incomplete note | Refused, naming each missing SOAP section |
| Manager reads a clinical note | `403` — notes are not a manager's business |
| Edit a signed note | `409` directing to an addendum; the original text is unchanged |
| Addendum | Accepted; status becomes `amended`, assessment intact |
| Nurse drafts a note | Allowed |
| Nurse signs a note | `403` — drafting and signing are separate grants |
| Prescribe against a recorded allergy | **Blocked**, naming the allergy |
| Doctor raises an invoice | `403` |
| Overpayment | Refused, naming the outstanding amount |
| Pay USD against a ZWL invoice with no rate | Refused |
| Pay 2 USD at 32.5 | Applied as 65 ZWL, `part_paid`, receipt states both |
| Reverse a payment | Counter-entry of −70; status returns to `part_paid` |
| Reverse the same payment twice | Refused |
| Patient balance | Re-derived from the ledger, never incremented in place |

### Claims and messaging, over HTTP

| Case | Result |
|---|---|
| List claims as receptionist/manager | Allowed through the claims permissions |
| Capture biometric on a draft claim | Status becomes `biometric_verified`, audit notice written |
| Submit draft or biometric-verified claim | Status becomes `submitted`, submission timestamp/reference written |
| Adjudicate a submitted claim | Records approved/paid/rejected outcome; rejected claims require a code |
| Submit an already-adjudicated claim | Refused |
| Queue a patient message | Stored for dispatcher delivery, scoped to the caller's practice |
| Cancel a queued message | Allowed while queued |
| Cancel a sent or failed message | Refused |

### Users, access, and configuration, over HTTP

| Case | Result |
|---|---|
| Admin changes **their own** role | Refused — *"ask another administrator"* |
| Admin deactivates **their own** account | Refused |
| Doctor lists users | `403` |
| Deactivate a clinician with unsigned notes | **Refused**, naming the count |
| Deactivated user signs in | Refused |
| Reassign a patient list | Moved, audited, named both clinicians |
| Invitation token | Issued once, stored only as SHA-256 |
| Accept with an 8-character password | Refused, citing the practice's own policy of 12 |
| Reuse an invitation token | Refused |
| Pre-mint a break-glass grant as admin | Refused — it must be self-taken, with its alert |
| Manager changes a scheme rate | `403` — configuration is administration |
| Admin changes 90% → 80% | Next invoice bills 20% to the patient, not 10% |
| Doctor reads the audit log | `403` |
| Manager reads the audit log | Allowed — *who accessed what* is theirs; note contents are not |
| Doctor reads settings | Allowed, but **without** integration identifiers |

### Serving a browser, over HTTP

The API was node-to-node and server-to-server until the frontend was wired to
it. What that added, and what it exposed:

| Case | Result |
|---|---|
| `GET /practices` | Public by necessity — sign-in names a practice, so the picker must be populated before anyone is authenticated. Returns name and city only: never users, counts, or settings |
| CORS preflight from an allowed origin | `204`, with credentials permitted |
| A disallowed origin | No `Access-Control-Allow-Origin`, so the browser refuses it. There is no wildcard — the API is credentialed, and a node that only talks to its peer should allow none |
| `POST /auth/unlock`, right password | `200`, and the **same token still resolves** — the session is resumed, not replaced, so a locked workstation is a pause rather than a logout with its state discarded |
| `POST /auth/unlock`, wrong password | `401`, and an `alert` audit entry survives the refusal |
| `POST /auth/unlock`, no session | `401` — a lock that outlives its session sends the user back to sign-in, instead of becoming a way to extend one indefinitely by never using it |
| `GET /auth/me` | The whole principal in one call — user, practice, role, registration — so a reload restores a session without a second round trip |

The unlock audit entry needed the transaction restructured. Throwing inside
`withTenant` rolls back, and the audit entry is the one thing that must survive
a failed attempt — someone guessing at an unattended machine in a clinic
corridor is exactly the event the lock exists for. So the transaction records
what happened and returns normally, and the refusal is raised after it commits.

### The patient registry, as a browser actually loads it

| Case | Result |
|---|---|
| `GET /patients` | One request carries the whole row: provider name, scheme, last visit, next appointment, balance, status |
| Doctor's own list vs the practice | A subset, by care relationship |
| Unrelated patient | `428` naming the patient, not `403` |
| Retry with a reason | `200`, `breakGlass: true`, a grant expiring end of day, an `alert` audit entry |
| Registration with a bad body | `400` with **field-level** errors, so a rejected form is correctable in place |
| Nurse edits demographics · doctor edits cover | Allowed · refused, field group by field group |
| Cross-tenant open | `404`, never `403` |

Resolving the provider and the appointments server-side is deliberate: the
registry is one screen, and returning ids for the client to resolve would be
three round trips to draw one table — which the lateral joins cost the database
far less than the network costs a clinic on a bad line.

**Two bugs came out of doing this**, neither reachable from the server alone.
An invalid or revoked token returned `403`, which a client cannot tell apart
from a genuine role refusal — so an expired session left someone in a workspace
that silently loaded nothing instead of returning them to sign-in. A missing
session is now `401`, and `403` means only "I know who you are, and no". And
the registry query lost the dollar sign from three parameter placeholders while
it was being extended, so `LIMIT $2` became `LIMIT 2` and every list request
failed at bind time — which surfaced only because a stale server process had
been answering the first test run.

### Replication, verified between two live nodes

A second database stood in for a clinic's local server, with both nodes running
the same code and differing only in `NODE_ID` and `SYNC_PEER_URL`.

| Case | Result |
|---|---|
| Patient registered on the local node while "offline" | Reached cloud, `origin=harare-local` preserved |
| Clinical note drafted offline | Replicated with it |
| Patient registered on cloud | Reached the clinic |
| Same patient edited on **both** nodes | Newer applied; **displaced version preserved** in `sync_conflict` |
| Resolving a conflict by keeping the displaced version | Restored it |
| Sync status during an outage | `behind`, with a pending count — not a misleading boolean |
| After reconnection | `up to date`, zero pending, zero conflicts |

Four bugs surfaced here that no amount of reading would have found:

1. **`seq` is a `bigserial`**, which node-postgres returns as a *string* to avoid
   truncating past `Number.MAX_SAFE_INTEGER`. `z.number()` rejected every push.
2. **`practice_settings` is keyed on `practice_id`**, so a blanket
   `ON CONFLICT (id)` matched no constraint and failed the batch.
3. **Foreign keys had to become deferrable.** A batch cannot always be ordered
   to satisfy them, and with immediate checks the first unsatisfied reference
   aborts the transaction — rolling back everything that had already succeeded,
   so the node retries the same failure forever.
4. **The replication echo.** Applying a peer's change fired the change-log
   trigger, queueing it straight back and making every round trip look like a
   concurrent edit: 39 "conflicts" out of 96 applied rows, none real.

And two that were silent, which is worse:

5. **`origin_node` recorded where a row was *created*, never updated.** Since
   `collect()` skips changes whose origin is the peer, cloud's own edit to a row
   that had originated at the clinic was never sent back down. Both sides
   reported success while the clinic quietly stopped receiving updates.
6. **Sequence-space confusion.** Acknowledging after a *push* advanced the
   peer's "already sent you" mark using our numbers, so it skipped its own
   unsent changes. The two nodes keep independent counters; only a *pull* is
   acknowledged.

### Bringing up a new node: snapshot, then stream

Replication works forward from the change log, so on its own it would seed a new
node with nothing. A local server brought up against an established practice
would agree about today and know nothing about last year — silently, because
every counter would read "up to date".

The seed closes that. On its first cycle a local node copies the practice's
current rows, records where the peer's change log stood when the copy began, and
streams forward from there.

- **The watermark is read before the rows, once, and held for the whole run.**
  A row edited mid-copy is therefore covered twice — the page may carry the old
  version, but its change sits above the watermark and arrives again through the
  ordinary loop, where newer-wins settles it. Re-reading the watermark per table
  would advance past those edits and lose them.
- **Paged by `id`, not by offset.** Rows are being written while the copy runs,
  and an offset would shift underneath it, skipping rows.
- **Nothing is marked complete until every table lands**, so a connection lost
  halfway simply repeats the copy next tick. Repeating is harmless: the writes
  are upserts of the peer's settled rows.
- **Logging is suppressed while seeding**, exactly as during ordinary apply.
  Without that, a seeded node's first act would be to queue the peer's entire
  database straight back at the peer.
- **`sync_peer.backfilled_at` records that it happened** (migration 013). NULL
  means never seeded, which is what every pre-existing row already says, so an
  established pair seeds once on its next cycle and never again.

**The practice row is the one row that cannot arrive this way**, because it *is*
the tenant — there is no tenant context in which to receive it. A node is
provisioned with two facts, `SYNC_PRACTICE_ID` and the node secret, and fetches
its own practice row from `GET /sync/identity` before anything else. `home_node`
is copied as cloud recorded it rather than overwritten: cloud is the register of
which practice has a local server, and a node that could name itself the home of
any practice it was pointed at would make that register meaningless.

Verified by dropping the local node's database, migrating it empty, and starting
it against a cloud node holding an established practice:

| Case | Result |
|---|---|
| Fresh node, first cycle | `seeded: 88` — bootstrapped its own practice row, then every table |
| Row counts across 19 tables | **Identical on both nodes**, cloud 88 / local 88 |
| The other practice's rows | **0** on the local node — RLS scoped the copy, not the caller |
| Local node's outbox after seeding | **0** — the seed was not echoed back at cloud |
| `last_recv_seq` after seeding | 7, the peer's watermark — cloud does not resend what the snapshot held |
| Change made on cloud afterwards | Streamed down normally, watermark 7 → 8 |
| Patient created on the local node | Pushed up, `origin=harare-local` preserved |
| Restart of a seeded node | **No second seed**; streaming resumed and delivered what it missed while down |

#### Two more bugs it forced

7. **`jsonb` columns holding arrays broke the batch.** node-postgres picks an
   encoding from the *value*, and a JavaScript array becomes a PostgreSQL array
   literal. That is right for `patient.allergies` (`text[]`) and wrong for
   `encounter.diagnoses` (`jsonb`), which failed with *"invalid input syntax for
   type json"* — and since a batch is one transaction, took every other change
   in it down too. Only the column's declared type distinguishes the two cases,
   so `writeRow` now looks the types up (cached per table) and casts explicitly.
   This was latent in ordinary replication too; the seed simply reached a coded
   diagnosis first.
8. **A node could name any practice.** The shared secret proves the caller is
   *a* node; it never proved *which* practice it may speak for. `/sync/pull` and
   `/sync/push` were shielded by RLS, but `/sync/identity` reads outside any
   tenant context by necessity — and returned Bulawayo's practice row to a node
   asking with Harare's credentials. `authenticateNode` now answers that second
   question from data rather than configuration: a peer may only name a practice
   whose `home_node` is that peer. A foreign practice and an unregistered node
   both get the same `401` as a bad secret, so neither learns anything.

#### Still open

The seed transfers rows, not attachments, and it is a full copy rather than a
resumable one — a large practice on a bad line will restart the copy from the
top rather than from where it stopped. Per-table resume is the obvious next
increment now that `backfilled_at` gives it somewhere to record progress.

### A third bug running it forced

Accepting an invitation failed as *"invalid or has expired"* for a perfectly
valid token — the same class of mistake as sign-in. `user_invitation` is
tenant-scoped, and resolving a token happens before a tenant is known, so RLS
correctly returned nothing.

That makes three operations that legitimately precede tenancy, and they now share
one shape: a `SECURITY DEFINER` function taking a hash and returning at most one
row (`resolve_session`, `resolve_invitation`, `password_policy`). Everything
afterwards runs inside a normal tenant-scoped transaction. Those three functions
are the complete list of cross-tenant reads in the system.

### A second bug running it forced

Editing a signed note was correctly *refused* by the trigger but surfaced as a
`500`. The immutability trigger raises `restrict_violation`, which PostgreSQL
reports as SQLSTATE **`23001`** — the translation table had `2F004`, which is
`reading_sql_data_not_permitted`. The record was never at risk; the caller was
simply told nothing useful. Reviewing the code would not have caught it, because
both constants look equally plausible on the page.

### One design change running it forced

RLS worked *too well*: `app_user` and `session` are tenant-scoped, but sign-in
must read them before a tenant is established, so every login returned zero rows.
Reviewing the SQL would never have caught it.

The fix avoids a broad exemption:

- **Sign-in needs no hole.** The caller states which practice they are signing in
  to, so the API scopes the transaction to it and RLS still applies. Claiming the
  wrong practice simply finds no user. The client chooses what to *scope to*, not
  what it may *access* — the password check still has to pass.
- **Token resolution genuinely cannot work that way**, since a bearer token
  carries no practice. `resolve_session()` is therefore `SECURITY DEFINER`, takes
  a SHA-256 hash, and returns at most one row. It is the only function in the
  system that reads across tenants, which makes it the single place to audit that
  boundary.

## Open questions

- **Data residency.** Whether Zimbabwean law permits health records offshore
  decides cloud versus in-country hosting. The code is deployment-agnostic so the
  answer changes configuration, not architecture — but it should be answered
  before production.
- **Secrets.** `practice_settings` holds NH263 and gateway *identifiers* only.
  Secrets belong in a secret store, write-only from the API, never returned to a
  browser.
