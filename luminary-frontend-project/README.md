# Luminary Health

An intelligent care operations platform for modern healthcare practices: patient records, scheduling, clinical workflow, billing, NH263 claims, patient engagement, and an AI layer, built as a modular enterprise PMS rather than a single-page dashboard.

**Status:** The workspace runs in two modes, decided at build time by `VITE_API_URL`. Unset is the seeded demo — in-memory, `localStorage`-backed, and what the standalone single-file build always is. Set, it runs live against `../luminary-server`, with the server owning authentication, tenancy, chart access and the audit trail.

Wired to the API so far: **sign-in, session restore, the idle lock, the patient registry, chart access including break-glass, registration, chart edits, and practice administration.** Still reading from seed data in both modes: appointments, encounters, billing, claims, messaging and the audit view — the endpoints exist and are tested, the shell has not been moved onto them yet. External integrations — the NH263 switch, payment gateways, SMS/WhatsApp delivery, AI execution — remain the final layer.

---

## Quick start

```bash
npm install
npm run dev            # build and serve http://127.0.0.1:5174/
```

```bash
npm run build             # production build to dist/
npm run build:standalone  # single-file Luminary-Health.html — double-click to run, no install
npm run serve:dist        # serve the production build on 127.0.0.1:5174
npm run preview           # Vite preview, if the local Vite toolchain is healthy
npm run lint              # ESLint, zero-warning policy
```

```bash
npm run verify            # everything below, in order, then the build
npm run verify:tokens     # no colour, size or radius outside the design scale
npm run verify:money      # dual-currency rules match what the server enforces
npm run verify:render     # renders as all 11 seeded users; no cross-tenant output
npm run verify:menus      # real clicks through jsdom over the header menus
```

**Running live.** Copy `.env.example` to `.env` and set `VITE_API_URL`, then allow `http://127.0.0.1:5174` on the server with `WEB_ORIGINS`. With an API running, `npm run verify:live` drives the real client modules against it — see the header of `scripts/verify-live.mjs` for the environment it needs.

**Running it elsewhere:** see **[RUNNING.md](RUNNING.md)** for getting this onto another computer — a single self-contained HTML file for demos, a static folder for hosting, or the full source for development.

**Verified state:** `npm run verify` passes clean end to end — lint, tokens, money rules, render, header menus, build — as does `npm run build:standalone`. `npm run verify:live` passes against a running API.

---

### Demo sign-in

Choose **Harare Central Clinic** and use password `luminary` for any seeded demo account:

| Role | Email | Workspace |
|---|---|---|
| Receptionist | `n.dhlamini@hararecentral.co.zw` | Front desk: patients, appointments, billing, claims, communications |
| Doctor | `m.chen@hararecentral.co.zw` | Clinical list and notes |
| Nurse | `s.moyo@hararecentral.co.zw` | Care operations |
| Practice manager | `r.chikafu@hararecentral.co.zw` | Operations, revenue, reports, audit |
| Administrator | `t.mapfumo@hararecentral.co.zw` | Users, settings, audit, platform configuration |

For tenant-boundary checks, sign in to **Bulawayo Family Practice** as `t.ncube@bulawayofamily.co.zw`.

---

## Architecture

```
src/
├── App.jsx                      session gate: login / lock screen / workspace
├── main.jsx                     React root
├── index.css                    design tokens, focus states, tabular numerals
├── config/
│   ├── access.js                navItems, patient-file tabs, re-exports the matrix
│   └── permissions.js           PERMISSIONS, roleAccess, metric scoping — no imports,
│                                so the server's contract test can read it directly
├── services/
│   ├── index.js                 the endpoint contract, read as a table
│   ├── api.js                   HTTP client, token handling, ApiError
│   └── patients.js              registry mapping and the live/demo directory hook
├── lib/
│   ├── access.js                tenancy, care relationships, break-glass, audit
│   ├── money.js                 dual-currency rules, mirrored from the server
│   ├── router.js                hash router
│   ├── workspace.jsx            WorkspaceProvider / useWorkspace
│   └── format.js                currency
├── data/
│   ├── organisation.js          practices, users, access grants
│   ├── registry.js              patient index + status tones
│   ├── patientRecords.js        full patient charts + completeness rules
│   ├── encounters.js            SOAP notes, vitals rules, ICD-10
│   ├── scheduling.js            appointments, rooms, providers
│   ├── billing.js               invoices, NH263 claims, claim lifecycle
│   ├── clinical.js              prescriptions, labs, care plans, queue
│   ├── engagement.js            messages, templates, campaigns
│   ├── intelligence.js          AI roster, insights, Ask Luminary knowledge
│   └── reporting.js             trends, productivity, payer mix, buildMetrics
└── components/
    ├── LuminaryDemo.jsx         workspace shell — state, actions, chrome, dialogs
    ├── LoginScreen.jsx          sign-in and lock screen
    ├── PatientFile.jsx          full-screen patient chart, view + edit
    ├── EncounterNote.jsx        SOAP editor with sign/amend lifecycle
    ├── ScheduleCalendar.jsx     day/week/rooms grid
    ├── LuminaryLogo.jsx         brand mark and wordmark as inline SVG
    ├── ui.jsx                   Modal, Field, Input, Select, Textarea, Button, Toast, EmptyState
    ├── shared/StatusPill.jsx
    └── pages/                   AIPage, AppointmentsPage, AuditPage, BillingPage,
                                 ClaimsPage, ClinicalPage, CommunicationsPage,
                                 DashboardPage, PatientsPage, ReportsPage,
                                 SettingsPage
scripts/
├── inline-standalone.mjs        folds the build into one self-contained HTML file
├── verify-tokens.mjs            guards the design scale
├── verify-money.mjs             dual-currency rules
├── verify-render.mjs            renders as every seeded user, checks tenancy
├── verify-header-menus.mjs      real clicks through jsdom
└── verify-live.mjs              client modules against a running API
```

**The split is done.** `LuminaryDemo.jsx` came down from **4,042 lines** to the shell alone — state, actions, chrome, routing, and dialogs. It has since grown back to ~1,900 as payments, live-mode wiring and the header menus landed, which is worth watching: the next thing to come out of it is the dialog set. All eleven module views live in `components/pages/`, all seed data in `data/`, permissions in `config/`.

Pages are views over a **workspace context** (`lib/workspace.jsx`) rather than taking dozens of props. The shell publishes one value — the signed-in user, the tenant-scoped collections, and the actions — and each page destructures what it needs. It is deliberately *not* a state container: state stays in the shell, so when mutations move behind the API only the shell changes and every page keeps working.

Every extraction was verified by re-rendering the workspace as every seeded user and comparing output: **byte-identical before and after**, with zero cross-tenant leakage. That check is now `npm run verify:render`, and covers all eleven users across both practices.

### Persistence

`lib/persistence.js` writes the workspace through to `localStorage`, so a refresh no longer wipes registered patients, written notes, raised invoices — or the audit log, which mattered most: an append-only compliance record that resets on F5 is worse than none, because it creates false assurance.

- **Versioned and namespaced** (`luminary:v1:*`). A schema change bumps the version and drops the old payload rather than half-reading it into a shape the code no longer understands.
- **Every access is guarded.** `localStorage` throws in private mode, at quota, and when a browser blocks site data. All of it degrades to in-memory with a single console warning; a corrupt payload falls back to the seed rather than crashing.
- **Reset demo data** in the user menu clears everything and reloads — the honest counterpart to persistence, and what you run between presentations.

It is a stand-in for the server, not a design for it: all tenants share one namespace here because scoping happens at read time, whereas a real backend scopes in the query.

### Service surface

`services/index.js` names every mutation the workspace performs and the endpoint that implements or will implement it — **50 operations across 11 groups**: auth, patients, appointments, encounters, billing, claims, messaging, users, settings, access, and audit. Read as a table, it is the frontend/backend contract: building the frontend first discovered the domain model, and this writes it down so the server implements it rather than reinvents it.

It also states the three rules the client cannot enforce: tenant scoping belongs in the query, permissions are re-checked server-side, and audit writes come from the authenticated principal, never from a field in the request body.

**State model.** The registry (`patientRows`) is the index; `patientRecords` holds the full chart. Appointments, invoices, claims, and messages are separate state arrays that reference patients **by name**, so nothing is invented locally. Dashboard metrics are computed from that state at render via `buildMetrics()` rather than hardcoded — the tiles cannot drift from the tables beneath them.

---

## Modules

| Module | What it does |
|---|---|
| **Overview** | Live operational metrics, today's schedule, care coordination queue, AI briefing |
| **Patients** | Sortable registry with search and record-completeness column, opening into a full patient file |
| **Appointments** | Calendar grid — day/week/rooms, drag-to-reschedule, click-to-book — with a visit detail panel and check-in progression |
| **Clinical** | Care coordination queue, daily plan, completion metrics |
| **Claims** | NH263 biometric claims switch — eligibility, fingerprint capture, submission, adjudication |
| **Billing** | Invoices, claim status, service lines with tariff codes, patient responsibility, and receipting in either currency with reversals |
| **Communications** | Message log, reminder campaigns, template library |
| **Reports** | Revenue trend, no-show analysis, provider productivity, payer mix, CSV export |
| **Luminary AI** | Agent manager, smart analytics feed, Ask Luminary assistant |
| **Audit log** | Append-only access record — who opened what, on what grounds |
| **Settings** | Practice control center: profile, hours, users, roles, integrations, sync health |

### Routing

`src/lib/router.js` is a small hash router — no dependency, ~60 lines.

**Hash, not the History API**, for two concrete reasons. The standalone single-file build runs from `file://`, where `pushState` throws a SecurityError because the document origin is null; fragments are unaffected. And hash routes need no server rewrite rules, so `dist/` drops onto any static host and deep links survive a refresh without configuration. The cost is uglier URLs, which for an internal clinical tool is a fair trade for working everywhere unchanged.

| URL | Opens |
|---|---|
| `#/` | Overview |
| `#/patients` | Registry |
| `#/patients/PT-2048` | Alice Johnson's file |
| `#/patients/PT-2048/notes` | …her Notes tab |
| `#/clinical/notes/NOTE-PT-2210-001` | That encounter note |
| `#/appointments/APT-03` | Calendar, that visit selected |
| `#/billing/INV-2026-012` · `#/claims/CLM-2026-0141` | Invoice / claim detail |
| `#/ai/ask-luminary` | Ask Luminary |

The URL is a *projection* of view state, not a second source of truth: `buildRoute()` derives the path from state, and a `hashchange` listener applies an incoming path back. A `appliedRoute` ref records the last path written or read so the two directions cannot chase each other.

- **Back and forward** move between modules and in/out of detail views. Selecting a different row *within* the same view rewrites the current history entry instead of pushing, so clicking through eight appointments does not cost eight presses of Back.
- **Restricted deep links fall back.** A doctor opening `#/billing/INV-2026-012` lands on the overview and the URL is corrected, rather than rendering blank or leaking a restricted view.
- **Unknown ids are ignored** rather than crashing on a stale bookmark.
- **`document.title` tracks the route** (`Patients · Alice Johnson · Luminary Health`) so several open tabs stay distinguishable.

### Scheduling calendar

`ScheduleCalendar.jsx` renders a real time grid rather than a list: time runs down, resources run across. Three views share one grid — **Day** (provider columns), **Rooms** (room columns, for resource conflicts), and **Week** (weekday columns).

Appointments are absolutely positioned from their start time and duration, so a 45-minute visit is visibly longer than a 30-minute one. That is the entire point over a list: you can see where the gaps are. Overlapping appointments are packed into lanes side by side so none is ever hidden.

- **Drag to reschedule.** Drop an appointment on any cell to move it. The parent owns the rules (`moveAppointment` → `findConflict`), so a clash is refused with a toast naming the conflict rather than silently overwriting.
- **Click an empty slot to book**, prefilled with that time, provider or room, and day.
- **Conflicts** are detected on shared provider *or* shared room, with real interval overlap — not just an equal start time, which was the previous naive check.
- **Colour is status**, keyed to the check-in progression, with a legend.
- A red **current-time line** tracks the clock and updates every minute.
- **Permissions apply**: without `scheduleVisit` nothing is draggable and cells are inert. A doctor with `ownPatientsOnly` sees only their own column.

`day` is an offset from today (0 = today), so bookings made into the week grid have somewhere to live. Everything that means *today* — dashboard tiles, the clinical day list, the day sheet export — reads `todaysSchedule`, which filters to `day === 0`.

### Patient file

The chart takes over the full workspace rather than sitting in a sidebar. Seven tabs — Summary, Demographics, Clinical, Cover & consent, Visits, Billing, Documents — over a banner carrying identity, cover, and a deliberately loud allergy strip that distinguishes *"no known allergies"* from *"nobody has asked yet."*

Records carry roughly 45 fields: identity (DOB with derived age, national ID, marital status, occupation, language), full address, next of kin, cover detail (principal member, dependant code, validity, status), clinical baseline (blood type, family history, immunisations, smoking/alcohol/exercise), consent flags, timeline, and documents.

**Record completeness** is the organising idea. Twelve fields in `REQUIRED_FIELDS` define a complete file; `recordCompleteness()` returns a percentage and the exact list of what is missing. The chart shows an amber bar naming the gaps with a *Complete now* link, and the registry carries a completeness column so gaps are visible without opening anything. Alyssa Harper sits at 50% by design — registered but never clinically intaked.

Editing switches the file into a grouped form with a sticky save bar. Validation rejects a future date of birth, a malformed email, and an emergency number identical to the patient's own. Saving propagates name and member-number changes back to the registry.

---

## Design system

Quiet PMS geometry, and — since the token pass — an actual system rather than a description of one. Every colour, size and radius comes from a named scale in `tailwind.config.js`; a component may not name a value the scale does not have, and `npm run verify:tokens` fails the build if one appears. Inter throughout, with `font-variant-numeric: tabular-nums` on tables so currency columns align.

**Type — eight steps.** `2xs` 10 · `xs` 11 · `sm` 12 · `base` 13 · `md` 15 · `lg` 17 · `xl` 20 · `2xl` 26. Size only, with no paired line-height: stamping one onto text that currently inherits would change the layout of a deliberately dense clinical table, which is a separate decision from the type scale.

**Radius — three.** `rounded-sm` 4px for pills and the smallest inline controls, `rounded` 6px for inputs, list rows and nested surfaces, `rounded-lg` 8px for cards, panels, modals and buttons. Status pills stay `rounded-full` where the shape carries the meaning.

**Colour — 41 names in five families:** ink and text, surfaces, lines, brand, and semantic tones. Each semantic tone carries a fill, a hairline and a label value (`success`, `success-soft`, `success-line`, `success-deep`, `success-bright`) so a pill, a calendar block and a progress bar read as one family. The dark sidebar gets its own `shell` ramp, because text on ink needs different values from text on white and mixing the two is how it accumulated six near-identical pale blues.

### Palette

The 41 names live in `tailwind.config.js`, grouped by role and commented there;
that file is the palette rather than a copy of it. The anchors:

| Token | Hex | Use |
|---|---|---|
| `ink` | `#0b1524` | Primary text, primary buttons |
| `shell` | `#08111f` | Sidebar background, with its own `on`/`text`/`muted`/`bright` ramp |
| `brand` | `#1466e0` | Primary accent, links, focus |
| `teal` | `#2ed3d6` | AI accents, logo upper panel |
| `body` | `#4a5c74` | Body copy |
| `muted` | `#5a6d87` | Labels, metadata — 5.29:1 on white |
| `line` | `#e3ebf5` | Card borders |
| `canvas` | `#edf2f8` | App background |
| `success` | `#0f7a5a` | Approved, normal, delivered |
| `warning` | `#96620a` | Pending, in review |
| `danger` | `#b3261e` | Rejected, overdue, abnormal |

Each of the three semantic tones also carries `-soft` (fill), `-line` (hairline),
`-deep` and `-bright`, so a pill, a calendar block and a progress bar are drawn
from one family rather than three approximations of it.

`src/index.css` holds exactly three custom properties — `--canvas`, `--ink`,
`--brand` — for the page chrome that is plain CSS with no class to hang a
utility on. It used to hold seventeen, used three times between them, three of
which had drifted from the values actually shipping.

### Logo

`LuminaryLogo.jsx` draws the mark as inline SVG: two skewed rounded panels — teal over azure — overlapping with `mix-blend-mode: multiply` so the intersection deepens, with an upright white cross set in the overlap. `LuminaryMark` is the mark alone, `LuminaryLogo` the full lockup; both take an `onDark` variant.

### Accessibility

Both muted greys were corrected to meet WCAG AA on white (`#7589a3` at 3.58:1 → `#5a6d87` at 5.29:1; `#9aabc2` at 3.1:1 → `#64778f` at 4.56:1). Patient rows are keyboard-reachable with Enter/Space activation and `aria-selected`. Sortable headers expose `aria-sort`; the table carries an `sr-only` caption. Icon-only buttons are labelled. The modal traps Tab, closes on Escape, moves focus in on open, and restores it on close. Tables scroll horizontally in their own containers. A global `:focus-visible` ring is defined, and `prefers-reduced-motion` is honoured.

---

## Tenancy, identity, and access

Four layers, deliberately independent. Collapsing them into "role" is what makes access control unmaintainable later.

| Layer | Question | Where |
|---|---|---|
| **1 · Tenant** | Which practice? | `organisation.js` — absolute, nothing crosses it |
| **2 · Role** | What *kind* of action? | `PERMISSIONS` / `roleAccess` |
| **3 · Relationship** | Which *patients*? | `lib/access.js` |
| **4 · Break-glass** | A logged exception to 3 | `lib/access.js` + audit |

### Multi-tenant

Two seeded practices — Harare Central Clinic and Bulawayo Family Practice — with eleven users between them. The tenant boundary is checked before anything else and **cannot be crossed by any role, permission, or break-glass**. Sign in as `t.ncube@bulawayofamily.co.zw` and the Harare cohort does not exist: not in the registry, not in search, not in the command palette, not in an export.

The practice is chosen explicitly at sign-in rather than inferred from the account, so a wrong-tenant login fails loudly instead of silently landing someone in another clinic's data.

### Care relationships, not ownership

A doctor's list is *derived*, not a `doctorId` column, because ownership cannot express "Dr. Ahmed covers this patient for two weeks." `careRelationship()` returns the strongest live reason a clinician may see a patient:

- **Primary provider** — the standing assignment
- **Booked with you** — an appointment in your clinic
- **You authored a note** — continuity of care
- **Temporary access** — a time-bounded grant (Dr. Ahmed covers Ezra Collins while Dr. Singh is on leave until 5 September)
- **Break-glass** — the documented exception below

Grants expire. An expired grant confers nothing.

### Break-glass, and why deny-by-default is wrong here

Hard-denying a clinician access to a chart is dangerous. The covering doctor, the locum, and the emergency at 2am all need a way through, and a system that says *no* with no override is one that gets someone hurt.

So layer 3 is permissive about **reading** and strict about **accountability** — the model real EHRs use. A clinician sees their own list by default and may widen to the whole practice, but opening a chart with no care relationship requires a written reason of at least ten characters, grants access only until end of day, and writes a permanent, prominently-flagged audit entry. The friction *is* the control; the deterrent is that everyone can see you looked.

While break-glass is active the patient context bar says so in red, so nobody forgets which footing they are on.

### Audit log

Append-only, scoped to the practice, visible to admins and practice managers. Managers can review *who accessed what* without being able to read clinical notes — access events are a compliance concern, note contents are not theirs. Records sign-in and sign-out, session lock and unlock, chart views with the relationship relied on, break-glass with its reason, and denied cross-tenant attempts.

### Sessions

Clinical workstations are shared, so the session **locks after 15 minutes idle** and returns to a lock screen naming the user, requiring their password rather than a full re-login. There is no long-lived "remember me" — actively harmful on a shared clinic desktop.

**Collections inherit tenancy from their patient.** Appointments, invoices, claims, notes, and messages are not tagged with a practice — which drifts — but filtered through the patient they belong to. If the patient is not in your practice, neither is their invoice. Mutations write to unscoped state; only what is *read* passes through the scope. This is asserted by rendering the whole workspace as every user in both practices and failing if a single foreign patient name appears anywhere in the output.

> **Demo mode is still UI-level.** The browser demo can be bypassed with devtools. The value is that the *model* is now right, and the backend in `../luminary-server` enforces the same role and tenancy shape server-side. Credentials in `organisation.js` are plaintext demo seeds.

---

## Role segmentation

Five roles sign in through the session gate. A single `roleAccess` map drives both visible modules and permitted actions, and the server mirrors it in `src/platform/permissions.ts`.

Current matrix:

| | Admin | Doctor | Nurse | Receptionist | Practice Manager |
|---|---|---|---|---|---|
| Overview | yes | yes, clinical | yes, care ops | yes, front desk | yes, ops + revenue |
| Patients | no | yes | yes | yes | yes |
| Appointments | no | yes | yes | yes | yes |
| Clinical | no | yes | yes | no | no |
| Billing | no | no | no | yes | yes |
| Claims | no | no | yes, biometric | yes | yes |
| Communications | no | yes | yes | yes | yes |
| Reports | yes | no | no | no | yes |
| Luminary AI | yes, full | yes, view | yes, view | no | yes, full |
| Settings | yes | no | no | no | no |
| Audit log | yes | no | no | no | yes |

The administrator column being almost empty is the point, not an oversight: running the system is not a clinical role, and provisioning an account never requires reading a chart.

Permissions are split by **the kind of harm getting them wrong would cause**, not by seniority. Administrative data (demographics, cover) and clinical data (notes, prescriptions) are separate grants, and *reading a clinical note* is its own permission. The 27 permissions live in `PERMISSIONS` and any user can inspect their own from the dashboard via **What can I do?**

Receptionist access is front-desk scoped: register patients, edit demographics and cover, schedule and check in visits, raise invoices, record payments, submit NH263 claims, capture biometrics, and send reminders. It deliberately excludes clinical notes, prescribing, reports, audit review, AI administration, and system settings.

| Permission | Admin | Doctor | Nurse | Receptionist | Manager |
|---|---|---|---|---|---|
| **Administrative** |
| See patient records exist | — | ✓ | ✓ | ✓ | ✓ |
| Register patients | — | — | ✓ | ✓ | ✓ |
| Edit demographics and contact | — | — | ✓ | ✓ | ✓ |
| Edit medical aid cover | — | — | — | ✓ | ✓ |
| Schedule visits | — | ✓ | ✓ | ✓ | ✓ |
| Check patients in | — | — | ✓ | ✓ | ✓ |
| **Clinical** |
| Read clinical notes | — | ✓ | ✓ | — | — |
| Record vitals | — | ✓ | ✓ | — | — |
| Draft encounter notes | — | ✓ | ✓ | — | — |
| Sign encounter notes | — | ✓ | — | — | — |
| Add addenda to signed notes | — | ✓ | — | — | — |
| Prescribe medication | — | ✓ | — | — | — |
| Order investigations | — | ✓ | — | — | — |
| Edit allergies, conditions, history | — | ✓ | ✓ | — | — |
| **Financial** |
| Raise invoices | — | — | — | ✓ | ✓ |
| Record payments and receipts | — | — | — | ✓ | ✓ |
| Submit NH263 claims | — | — | — | ✓ | ✓ |
| Capture patient biometrics | — | — | ✓ | ✓ | — |
| **Platform** |
| Message patients | — | ✓ | ✓ | ✓ | ✓ |
| Manage AI agents | ✓ | — | — | — | ✓ |
| Export reports | ✓ | — | — | — | ✓ |
| **Administration** |
| Add and deactivate users | ✓ | — | — | — | — |
| Assign roles | ✓ | — | — | — | — |
| Configure the practice | ✓ | — | — | — | — |
| Manage NH263 and gateway credentials | ✓ | — | — | — | — |
| Set leave and covering arrangements | ✓ | — | — | — | ✓ |
| Review the audit log | ✓ | — | — | — | ✓ |

All 27, exactly as `config/permissions.js` declares them — and as
`luminary-server/src/platform/permissions.ts` independently declares them.
`npm run contract:permissions` in the server asserts the two agree, cell by
cell, and fails the build if they drift.

Five judgements worth defending:

- **Admin cannot read a chart at all**, let alone sign or prescribe. System administration is not a clinical qualification, and provisioning an account has never required seeing that a patient exists. An administrator who genuinely needs a chart goes through break-glass and is audited for it like anyone else.
- **Managers cannot read clinical notes at all.** Running a practice does not require reading what a patient told their doctor. This is minimum-necessary access, and the Notes tab and Clinical module are hidden from them entirely rather than shown empty.
- **Nurses draft, doctors sign.** A nurse can take vitals and write the note up; only a prescribing clinician can put their name to it. The editor states this rather than just disabling the button.
- **Doctors do not edit demographics or cover.** That is reception's job, and keeping clinicians out of it reduces both error and temptation.
- **Receptionists take money but never open a note.** The front desk registers, schedules, checks in, invoices, receipts and claims — everything that happens at the counter — and none of what happens in the room.

Doctors also see **their own patients only** (`ownPatientsOnly`), so the clinical workspace is their list, not the whole clinic's.

> **Demo gating is not access control.** The backend mirrors this matrix in `src/platform/permissions.ts` and must remain the authority once the frontend is wired to live API calls. Hiding a button is still just presentation.

---

## What actually works

Interactive, with validation and visible consequence:

- **Register patient** — requires full name, DOB, sex, national ID, phone, city, next of kin name and number, member number unless self-pay, and consent to treat. Rejects duplicates and future birth dates. Drops you into the new file to finish intake.
- **Edit patient record** — full chart editing with validation, propagating to the registry.
- **Schedule visit** — blocks double-booking a provider in the same slot, inserts in time order.
- **Raise invoice** — live-previews the insurance split from the scheme configuration, updates the patient balance.
- **Record payment** — in either currency, with the rate at the moment of payment stored alongside it. Overpayment is refused rather than held as credit, a receipt states what was tendered and what it became, and a reversal is a counter-entry so the ledger keeps both the mistake and the correction.
- **Send message** — template presets fill the body, 160-character counter, appends to the log.
- **Check-in progression** — Booked → Checked in → In consultation → Completed, plus No-show.
- **NH263 claim flow** — capture fingerprint → submit to switch, with a per-claim response timeline.
- **CSV exports** — real downloads (BOM-prefixed for Excel): provider productivity, accounts receivable, day sheet, message log, claims remittance.
- **Command palette** — Ctrl/Cmd+K over patients, modules, and actions, role-filtered.
- **Alerts panel** — derived from live state (overdue invoices, rejected claims, unbooked patients, awaiting intake), each navigating to its module.

Deliberately not wired, and they say so via a toast rather than failing silently: task capture and multi-site workspace switching.

### Simulated, not real

Honest accounting of what a demo viewer might assume is live:

- **Demo mode is the default.** With no `VITE_API_URL` the workspace persists to `localStorage` and checks credentials in the browser. That is a demonstration, not a security boundary, and the sign-in screen says which mode it is in. Live mode moves authentication, tenancy and the audit trail to the server.
- **Most modules still read seed data in both modes.** Patients and administration are wired; appointments, encounters, billing, claims, messaging and audit are not yet, though their endpoints exist and are tested. Until they are, live mode shows real patients beside seeded appointments — which is the single most misleading thing about the current build, and the reason it is stated here.
- **NH263 switch** is simulated in `captureBiometric()` and `submitClaimToSwitch()` on the frontend and exposed as an internal claims lifecycle on the backend. The real NH263 switch/proxy remains an external integration.
- **Ask Luminary** matches keywords against `askLuminaryKnowledge`, with a graceful fallback. It is not a language model.
- **AI agents** display metrics and pause/resume; they do not execute work.
- **Charts** are CSS bars with labelled values, not a charting library.
- **Export PDF** calls `window.print()` rather than generating a PDF.

---

## Roadmap

**Phase 1 — Core operations · complete.** Shell, registry, appointments, billing, reports, shared layout.

**Phase 2 — Clinical depth · complete.** Patient file with full chart and editing, clinical timeline, prescriptions, lab results, care plans, claims, communications.

**Phase 3 — Automation and intelligence · surfaced, not wired.** Agent manager, smart analytics, and Ask Luminary all exist as UI. Making them real needs the API layer.

**Phase 4 — Enterprise scale · first slice implemented.** Admin settings, user management service contracts, settings API routes, audit/sync visibility, and the practice control center are in place. Multi-site workspace switching, approval workflows, compliance reporting packs, and enterprise policy automation still come after the core API wiring.

### Next, in the order I would do it

1. **Move the rest of the shell onto the API.** Patients and administration are wired; appointments, encounters, billing, claims, messaging and audit are not, and until they are, live mode shows real patients beside seeded appointments. The pattern is established in `services/patients.js` — mappers plus a mode-aware hook — and appointments is the natural next one, since the calendar's conflict rules are already enforced server-side by an exclusion constraint.
2. **Payments end to end.** The receipting UI and its rules exist and are tested, but in demo mode only; the server has had `recordPayment` and `reversePayment` all along.
3. **Prescribing workflow** — a doctor can authorise a repeat, but there is no surface to write a *new* prescription with dose, route, and duration.
4. **Vertical rhythm.** The type scale sets size without line-height on purpose. Pairing one with each step is the obvious next design move and changes spacing across every dense table, so it wants looking at rather than inferring.
5. **Integrations last.** NH263 switch, payment gateways, SMS/WhatsApp delivery, and AI execution plug into seams that already exist, once the core surfaces are real.

Two smaller things that are not on the list but should be: the server has no
ESLint configuration at all, so `npm run lint` there fails outright; and the
documents named below contradict this one and should be deleted rather than
annotated.

Done since the last revision: the design token pass, the header menu fixes, the
patient registry and administration on live API, payments and receipting, the
permission contract test, and the verification suite.

---

## Design principles

Quiet and premium rather than noisy. Clinical and trustworthy. Modular, not dashboard-only. Dense but readable. Hierarchy over decoration. One consistent system across every module.

---

## Other documents

`DEVELOPMENT.md`, `PRESENTATION_SCRIPT.md`, `FRONTEND_DEMO_SETUP.md`, `DEMO_QUICK_START.txt`, `DEMO_READY.txt`. These predate the current build and describe an earlier staged plan — treat this README as the source of truth where they disagree.

---

## Changelog

Twenty-nine iterations, most recent first.

**29 · The README caught up with the code.** Documentation drifts quietly and this had drifted a long way, so it was checked against the source rather than reread. What was wrong: the status paragraph still said nothing was wired to the API; the architecture tree listed five of the eleven pages and omitted `scripts/` entirely; the shell was described as ~1,500 lines when it is ~1,900 and growing; render verification was credited to "all seven users" when there are eleven; the modules table was missing Audit and Settings; and the palette table still presented fifteen colours as the palette while pointing at CSS custom properties that no longer hold it — directly contradicting the section above it.

Two errors mattered more than the rest. The permission table was four roles wide when there are five, omitted **Record payments** entirely, and sat beneath a second, superseded copy of the role matrix that was "retained as historical changelog context" — which is what the changelog is for. And a bullet claimed an administrator "can read a note for support purposes", which the matrix immediately above it contradicts: `viewClinicalNotes` has been false for admin since the role was rewritten, and break-glass is the only way in. The replacement table is all 27 permissions across all five roles, checked cell by cell against `config/permissions.js` rather than typed from memory.

The honest-accounting section now says the thing most likely to mislead someone opening the app: patients and administration read from the API, while appointments, encounters, billing, claims, messaging and audit still read seed data, so live mode currently shows real patients beside seeded appointments.

**28 · The design system becomes one.** The look barely changes; the system behind it does. Measuring first turned up the state of things: **75 distinct hex values** in the components, **fifteen** font sizes running 9,10,11,12,12.5,13,14,15,16,17,18,19,20,22,26 — most a single pixel apart — and **six** radii including strays at 3, 5 and 7px that a pass two iterations earlier was supposed to have removed. The named tokens in `tailwind.config.js` were used exactly **zero** times, which is why three of them had quietly drifted from what was shipping, one of them a grey that failed contrast. Seventeen CSS custom properties were used three times between them.

Now: 41 named colours in five families, eight type steps, three radii. **1,191 utilities rewritten across 22 files.** Most were pure renames with byte-identical output; the ones that moved are the point — thirty near-duplicate colours folded into their neighbours (four off-whites within two percent of each other, six greys inside one band, four pale blues in the sidebar) and seven sizes shifted by a pixel. Each semantic tone gained the fill, hairline and label values it needed so a pill, a calendar block and a progress bar come from one family. The sidebar got its own `shell` ramp. Rendered markup dropped ~1.4 KB per page and the stylesheet 51.4 → 48.4 KB, which is incidental but a fair proxy for how much duplication there was.

Added `npm run verify:tokens`, because consolidating was the easy half — a single pasted `text-[#5a6d87]` costs nothing today, and there were 1,032 of them by the time anyone counted. It fails on any colour, size or radius a component names that the scale does not have, with the two narrow exemptions stated in the file: the SVG logo, and shadows and gradients whose multi-part rgba no colour token can express. It caught four leftovers the codemods missed the moment it was written — three side-specific `rounded-t-[4px]`, and a chart colour hiding in a data file rather than a component.

Not attempted, and worth saying: vertical rhythm. Pairing a line-height with each type step is the obvious next move and would change spacing across every dense table, which is a thing to look at rather than infer — so the tokens set size only for now.

**27 · The header menus, and a test that could actually see them.** The account menu did not switch cleanly to the alerts menu, or back. Both dropdowns rendered their own full-screen backdrop at `z-30` to catch outside clicks, while their trigger buttons sat at `z-index: auto` — so whichever menu was open covered *both* triggers, and clicking the other one landed on the backdrop instead of the button. The first menu closed, the second never opened, and every switch between them cost two clicks.

Rebuilt on a single `headerMenu` slot: the two are now mutually exclusive by construction, exactly one backdrop is ever mounted, and the triggers sit above it. Escape closes an open menu, both triggers carry `aria-haspopup`, and clicking an open trigger still closes it.

A second stacking fault sat underneath the first: the menus also rendered *behind* the dashboard. `backdrop-blur` creates a stacking context, so the dropdowns' `z-40` only ever applied inside the blurred header — and every `.lh-card`, `.lh-metric` and `.lh-page-hero` blurs too and comes later in the document, so the content painted over the open menu. Raising the dropdown's own z-index could never have fixed it; only the blurred ancestor's can. The header now carries `relative z-20`, above content and below the modal layer, and `index.css` documents the whole scale — content 0, header 20, menu backdrop 30, menus 40, modal 50, palette 55, toast 60 — with the `backdrop-blur` trap written down beside it, since it has now caused both bugs.

Three smaller faults surfaced alongside it. The registration line read `currentUser.hpcz`, a field only the seed defines — the server calls it `registration`, so in live mode that line silently never rendered. `roleInfo.label` was `jobTitle`, which is optional server-side, leaving a blank line under the name in the account menu and "The  role covers…" in restricted views; it now falls back to the role. **Reset demo data** is hidden in live mode, where clearing local storage achieves nothing and implies a rollback that is not possible. And `onSwitchUser` was dropped from `App.jsx` — passed ever since the session gate landed, never destructured, and the workspace switcher deliberately shows a toast instead.

Added `scripts/verify-header-menus.mjs` (`npm run verify:menus`), which drives real clicks through jsdom. Nothing else here could have caught this: it built, it linted, and it server-rendered identically — the bug only existed once two menus and a mouse were involved. The first version of that test was itself worthless, hit-testing with `getComputedStyle`, which in jsdom reports `z-index: auto` for everything because no stylesheet is loaded; it passed just as happily with the bug put back. It now reads stacking from the class names, and was confirmed the only way worth trusting — by reintroducing the bug and watching it fail.

**26 · The patient registry runs on the API.** The workspace now has two modes decided at build time by `VITE_API_URL`: unset is the seeded demo (and is what the standalone single-file build always is), set is live against the server. Sign-in, session restore, the idle-lock password re-check, the patient registry, chart access, registration, and chart edits all go through the API in live mode. Everything else in the shell still derives its rows from the patient registry, so this one collection carried the tenancy scoping across with it.

There is deliberately no fallback: a failed request in live mode is an error, never a quiet substitution of seeded patients. A clinical system that invents records when the network drops is worse than one that says it cannot reach the server.

Chart access is now the server's decision rather than the client's. It answers `428` with the patient named when only break-glass would allow it, and writes the grant, the expiry, and the flagged audit entry itself — the client asks and reacts. Chart edits send only the fields that changed, because the server permissions updates field group by field group and posting the whole record back is refused for groups the caller cannot write.

Added `scripts/verify-live.mjs` (`npm run verify:live`), which drives the real client modules against a running API rather than testing the endpoints alone — a server can return a perfectly correct row that the mapper turns into a registry entry with an undefined name, and every HTTP assertion would still pass. It is excluded from `npm run verify`, which must work with no server and no network.

Three bugs came out of running it. The registry list query lost the `$` from three parameter placeholders, so `LIMIT $2` became `LIMIT 2` and every list request failed at bind time. An invalid or revoked token returned `403`, which a client cannot distinguish from a genuine role refusal — so an expired session left someone in a workspace that silently loaded nothing instead of returning them to sign-in; missing sessions are now `401` and `403` means only "I know who you are, and no". And a tenancy check that appeared to fail catastrophically — two practices seeing identical patient lists — turned out to be the API running as a superuser, which bypasses row-level security entirely. That one is now written down in both READMEs, because it makes every tenancy guarantee in the system silently untrue.

**25 · Design system applied across every page, and the build unbroken.** The `.lh-*` component classes introduced in 24 now cover all eleven pages rather than three: page heroes, metric tiles, card shells, buttons, section labels, and selectable rows each resolve to one definition instead of a hand-copied class list. Settings folded in the block those classes were originally abstracted from, which also settled two details it had drifted on — a 28px title where every other page uses 26, and a kicker that had lost its tracking. Removed `AdminStatusCard`, defined but never rendered, along with the three icons imported only for it; the page already drew those cards inline.

Fixed the break that had left the app failing to compile since the previous session. `bg-white/82` and `bg-white/78` are not on Tailwind's opacity scale, which runs 75, 80, 85, 90 — so `@apply` treated them as unknown classes and took the whole stylesheet down, dev server and production build alike. Arbitrary opacities need bracket syntax. Two characters, and nothing had built for hours.

Added `npm run verify`: lint, the money rules, a render check, then the build. `scripts/verify-render.mjs` renders the workspace for all eleven seeded users and greps the rendered markup for patients belonging to another practice — the output, not the access functions, because an earlier audit passed by exercising the functions while deep links were quietly opening another practice's chart. `scripts/verify-money.mjs` asserts the dual-currency rules agree with what the server enforces, including that overpayment is caught after conversion rather than before. All four stages pass, as does the standalone build.

**24 · Apple-like shell and settings polish.** Refined the app frame, sidebar, workspace switcher, top header, alerts/user menus, patient context strip, modal geometry, and the Settings page into a quieter 8px-radius system with lighter surfaces, clearer hierarchy, and less heavy blue. Verified with `npm run build`.

**23 · Enterprise administration layer, first slice.** Added live-mode service coverage for users, settings, sync conflicts, audit summary, expiring registrations, room/security settings, offboarding, role changes, session revocation, and the practice control center. Fixed the universal Settings button so admins navigate correctly and restricted roles receive a clear message instead of an error.

**22 · PMS backend core surfaces.** Added backend messaging routes and claims lifecycle endpoints for listing claims, claim detail, biometric capture, submission, and adjudication. Extended the frontend API contract to cover claims, messaging, users, settings, access, and audit.

**21 · Receptionist login and role.** Added a seeded receptionist account (`n.dhlamini@hararecentral.co.zw`) and a front-desk workspace covering patients, appointments, billing, claims, and communications. Added the `receptionist` role to the frontend permission matrix and server authorization matrix, including migration `014_receptionist_role.sql`; the permission contract now verifies 5 roles x 27 permissions.

**20 · Split completed, persistence, and the service surface.** `LuminaryDemo.jsx` finished at ~1,500 lines from 4,042 — all ten module views now in `components/pages/`, with Luminary AI's chat and agent state moved into the page where it belongs. Added `lib/persistence.js`: versioned, namespaced `localStorage` write-through for every collection including the audit log, guarded against private mode, quota, blocked site data, and corrupt payloads, with a **Reset demo data** control. Added the first `services/index.js` contract, then 29 endpoints, plus the three rules the client cannot enforce. Verified with a persistence round-trip, a no-DOM degradation check, and byte-identical render output for all seven users across every extraction.

**19 · Codebase split, part one.** `LuminaryDemo.jsx` reduced from 4,042 to ~2,900 lines. All seed data extracted to ten modules under `data/` and `config/`; five module views extracted to `components/pages/`; `StatusPill` to `components/shared/`; the dead `aiAgents.js` and `mockData.js` removed. Introduced a workspace context (`lib/workspace.jsx`) so pages consume shared state without prop threading.

Also closed tenant-isolation holes found while auditing the previous iteration: appointments, invoices, claims, notes, and messages now inherit tenancy from their patient, and deep links run through the same access check as the registry — previously a pasted URL opened another practice's chart outright, bypassing both tenancy and break-glass. Caught because the earlier test exercised the access *functions* but never the rendered output; the test now renders the whole workspace as all seven users and fails on any foreign patient name. Every extraction re-verified the same way, with byte-identical render output before and after.

**18 · Authentication, tenancy, and access control.** Login screen with explicit practice selection; two seeded practices and nine users. Four independent access layers — tenant, role, care relationship, break-glass. A doctor sees their own derived list (primary provider, booked with you, authored a note, time-bounded grant) and may widen to the practice, but opening a chart outside it requires a written reason, expires at end of day, and writes a flagged audit entry. Append-only audit log for admins and practice managers. Idle session lock at 15 minutes with password re-entry. Role switcher replaced by a real user menu. Verified with assertions covering the tenant boundary (uncrossable even by staff-wide roles), expired grants, break-glass scoping, and that no patient data renders before authentication.

**17 · Routing and URL state.** `src/lib/router.js`, a dependency-free hash router. Deep links to any module, patient file, file tab, encounter note, invoice, claim, or AI tab; working browser Back and Forward; refresh keeps your place; `document.title` tracks the route. Hash rather than History API because `pushState` throws on `file://` and would have broken the standalone build, and because hash routes need no static-host rewrite rules. Detail-within-view changes replace the history entry rather than pushing, so Back is not swamped by row clicks. Restricted deep links fall back to the overview and correct the URL. Patient-file tab state lifted so it can live in the URL. Verified with 24 router assertions plus a simulation of the two-way sync proving it converges in every scenario — mount, navigation, deep link, Back, restricted link, and rapid module hopping — with no loops.

**16 · Scheduling calendar.** `ScheduleCalendar.jsx` — a real time grid with Day, Week, and Rooms views, appointments positioned and sized by duration, lane-packing so overlaps stay visible, drag-to-reschedule, and click-an-empty-slot to book. Interval-based conflict detection on shared provider or room, replacing an equal-start-time check that missed genuine overlaps. Appointments gained `id`, `day`, and `duration`; `todaysSchedule` keeps every "today" surface honest now that bookings can land on other days. Current-time line, status colour legend, and permission-aware interaction (no drag without `scheduleVisit`; doctors see only their own column). Verified by rendering all three views with deliberately overlapping appointments and asserting none were dropped.

**15 · Portable distribution.** `npm run build:standalone` produces a single self-contained `Luminary-Health.html` that runs by double-click — a classic IIFE bundle rather than ES modules, because browsers block `type="module"` over `file://`. See [RUNNING.md](RUNNING.md). Archived a stale prototype that had been shipping in every build.

**15 · Doctor's experience and clinical documentation.** SOAP encounter notes (`EncounterNote.jsx`, `encounters.js`) with vitals capture, automatic abnormal-vitals flagging, ICD-10 diagnosis coding, and a Draft → Signed → Amended lifecycle where signing locks the body and corrections become addenda. A doctor-segmented clinical workspace showing their own patients, notes to complete, results to review, and refills to action. Three entry points into the same editor: the clinic list, the patient file's Notes tab, and the notes-to-complete queue. Permissions rewritten from 10 coarse flags to 19 granular ones split by data class, with a self-service **What can I do?** panel. Verified by rendering all 5 notes under all 4 role profiles and asserting no signed note exposes an editable field.

**14 · Patient file.** Full-screen chart replacing the sidebar; `patientRecords.js` with ~45 fields per patient; seven tabs; grouped edit form with validation; record-completeness meter with named gaps, surfaced in the registry; expanded registration capturing identity, contact, next of kin, cover, and consent. Verified by server-rendering all eight files.

**13 · UX audit remediation.** Design-system pass (enterprise radii, Inter, tabular numerals, compressed type scale); accessibility fixes (contrast, keyboard rows, ARIA, focus trap); data reconciliation onto one registry; create/edit forms; CSV exports; command palette; alerts panel; persistent patient context bar; UI primitives extracted to `ui.jsx`.

**12 · Brand identity.** Logo as inline SVG plus favicon; 117 ad-hoc warm hex values consolidated to 51 brand colours; tokens in CSS and Tailwind; fixed an invalid Tailwind content glob.

**11 · Role segmentation.** Four roles, `roleAccess` map, filtered navigation, scoped metrics, action-level gating.

**10 · Luminary AI.** Agent roster with pause/resume, cross-module insight feed, Ask Luminary with cited sources.

**9 · NH263 claims.** Claims module with lifecycle statuses, biometric verification, switch response timeline.

**8 · Communications.** Message log, campaigns, template library, engagement metrics.

**7 · Patient search.** Live filtering with an empty state.

**6 · Check-in workflow.** Visit status progression and no-show handling.

**5 · Reports deepening.** Revenue trend, no-show analysis, provider productivity, payer mix.

**1–4 · Foundations.** Billing invoice detail with service lines and claim status; prescription management; lab results; care plans with progress tracking.

### Bugs found and fixed along the way

- **Blank screen from a temporal dead zone.** `paletteResults` read `access` and `alerts` read `claims`, both declared ~60 lines later. `useMemo` runs during render, so React threw and unmounted the tree. The build passed throughout — a compiling module proves nothing about runtime. Now verified by actually server-rendering the component.
- **UTF-8 double-encoding**, twice, from PowerShell scripted edits reading UTF-8 as CP1252. Reversed by re-encoding through CP1252; all 100 special characters verified intact.
- **`TriangleAlert`** does not exist in lucide-react 0.263 — the name is `AlertTriangle`.
- **Escaped quote** inside a `className` rendering a literal backslash.
- **Invalid Tailwind glob** `./public/**/*.{html}`, warning on every build.
