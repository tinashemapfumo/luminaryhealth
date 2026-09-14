# Luminary Health — Scenario-Based Workflow Audit
## Stage 1A: Patient Registration → Appointment → Consultation

**Date:** 2026-09-11
**Mode:** Read-only product-logic audit. No repository code, schema, migration, configuration or test was created or modified.
**Scope:** Patient identification/registration → appointment creation → arrival/check-in → clinical queue/handoff → consultation → encounter completion/signing. **Stops before** billing, payments, claims, pharmacy, adjudication, messaging campaigns, reporting, finance, NH263 and external integrations.

**Method:** Every finding below was traced through the implementation, not inferred from documentation or from the existence of a route or button. Primary evidence:

| Area | Files read |
|---|---|
| Patient model | `db/migrations/003_patients_and_access.sql` |
| Registration rules | `src/modules/patients/patients.routes.ts`, `patients.service.ts` |
| Care relationship | `db/migrations/004_clinical_and_billing.sql` (`care_relationship()`) |
| Scheduling | `db/migrations/004`, `src/modules/scheduling/scheduling.routes.ts`, `scheduling.repository.ts` |
| Clinical | `db/migrations/004`, `src/modules/clinical/clinical.service.ts` |
| Client workflow | `src/components/LuminaryDemo.jsx`, `src/services/patients.js`, `src/data/patientRecords.js`, `src/data/clinical.js` |

---

## 1. Workflow Map

### 1.1 The ideal operational path

```
                          PATIENT ARRIVES / PHONES
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
              KNOWN PATIENT?                   NEW PATIENT
                    │                               │
         ┌──────────┴──────────┐                    │
         │                     │                    │
    search by name /      no match found ───────────►│
    phone / patient no /                            │
    national ID /                            ┌──────▼──────────────────┐
    member number                            │ DUPLICATE CHECK          │
         │                                   │ (name, DOB, national ID, │
    ┌────▼─────────────┐                     │  member no, phone)       │
    │ CONFIRM IDENTITY │                     └──────┬──────────────────┘
    │ (DOB / ID shown) │                            │
    └────┬─────────────┘                     ┌──────▼──────────────────┐
         │                                   │ CAPTURE                  │
    ┌────▼──────────────┐                    │  identity · demographics │
    │ UPDATE ON CHANGE  │                    │  contact · cover         │
    │ phone/address/    │                    │  emergency contact       │
    │ cover (audited,   │                    │  GUARDIAN if minor       │
    │ history retained) │                    │  consent (versioned)     │
    └────┬──────────────┘                    │  allergy status asked?   │
         │                                   └──────┬──────────────────┘
         └───────────────┬──────────────────────────┘
                         │
              ┌──────────▼───────────┐
              │ COMPLETENESS CHECK   │  warn vs block decision
              └──────────┬───────────┘
                         │
         ┌───────────────┴────────────────┐
         │                                │
   BOOKED VISIT                       WALK-IN
   (phone/earlier)                    (no appointment)
         │                                │
   ┌─────▼──────────────┐          ┌──────▼─────────────────┐
   │ APPOINTMENT        │          │ QUEUE PLACEMENT        │
   │  patient · reason  │          │  next available /      │
   │  provider · room   │◄─────────┤  named provider /      │
   │  date/time         │  or a    │  priority              │
   │  duration by type  │  same-day└──────┬─────────────────┘
   └─────┬──────────────┘  appt           │
         │                                │
    ┌────┴─────────┬──────────┬───────────┘
    │              │          │
 RESCHEDULE    CANCEL     NO-SHOW
 (history      (reason,   (who/when,
  preserved)    who/when)  reversible)
    │              │          │
    └────┬─────────┘          │
         │                    │
   ┌─────▼─────────────────┐  │
   │ ARRIVAL / CHECK-IN    │  │
   │  arrived_at recorded  │◄─┘ (late arrival re-opens)
   │  identity reconfirmed │
   └─────┬─────────────────┘
         │
   ┌─────▼──────────────────────┐
   │ WAITING FOR TRIAGE          │  ← OPTIONAL BRANCH
   └─────┬──────────────────────┘
         │
   ┌─────▼──────────────────────┐        ┌──────────────────────────┐
   │ NURSE TRIAGE                │   OR   │ DIRECT TO DOCTOR         │
   │  vitals · presenting concern│        │ (practice has no nurse;  │
   │  triage complete            │        │  doctor takes own vitals)│
   └─────┬──────────────────────┘        └──────┬──────────────────┘
         │                                       │
         └──────────────┬────────────────────────┘
                        │
              ┌─────────▼──────────────┐
              │ WAITING FOR DOCTOR      │
              └─────────┬──────────────┘
                        │
              ┌─────────▼──────────────────────────┐
              │ CONSULTATION (IN PROGRESS)          │
              │  verify patient · review history    │
              │  review allergies · previous visits │
              │  S · O · A · diagnosis · plan       │
              │  (draft survives interruption)      │
              └─────────┬──────────────────────────┘
                        │
              ┌─────────▼──────────────┐
              │ VALIDATION BEFORE SIGN  │  template-appropriate,
              │  required sections      │  not one-size SOAP
              │  ≥1 diagnosis           │
              │  signer authorised      │
              │  registration valid     │
              └─────────┬──────────────┘
                        │
              ┌─────────▼──────────────┐
              │ SIGNED (IMMUTABLE)      │
              └─────────┬──────────────┘
                        │
         ┌──────────────┴───────────────┐
         │                              │
   POST-SIGN CORRECTION           VISIT CLOSURE
   (addendum: actor/time/reason)  appointment → completed
         │                        patient leaves queue
         └──────────────┬─────────────────┘
                        │
                 ┌──────▼──────┐
                 │ VISIT CLOSED│   (downstream work handed off —
                 └─────────────┘    out of scope for Stage 1A)
```

### 1.2 What Luminary actually implements

```
REGISTRATION
  POST /patients  ── required: reference, fullName (must contain a space),
                     dateOfBirth (≤ today), sex, nationalId, phone,
                     addressCity, emergencyName, emergencyPhone,
                     consentTreatment === true
                  ── refine: emergencyPhone ≠ phone
                  ── NO duplicate check of any kind
                  ── NO guardian concept
                  ── audit: 'Registered patient' (notice)

  PATCH /patients/:id ── field groups: demographics | cover | clinical
                      ── unknown columns SILENTLY IGNORED
                      ── date_of_birth, sex, national_id, reference
                         belong to NO group → uncorrectable via API

APPOINTMENT
  POST /appointments ── patientId, providerId, roomId?, startsAt,
                        durationMin (default 30), visitType? (free text),
                        mode (in_person | telehealth)
                     ── DB: exclusion constraints on provider and room
                     ── no visitType → duration mapping
                     ── no patient double-booking constraint

  PATCH /appointments/:id ── overwrites startsAt/duration/provider/room
                          ── no status guard, no reason, no history

  POST /appointments/:id/status ── guarded by `checkIn` permission
       booked          → checked_in | no_show | cancelled
       checked_in      → in_consultation | no_show | cancelled
       in_consultation → completed
       completed       → (terminal)
       no_show         → booked
       cancelled       → booked
                          ── no reason captured on any transition
                          ── no arrived_at; only starts_at exists

CONSULTATION
  POST /encounters ── patientId, appointmentId? (nullable, unvalidated)
                   ── no check appointment belongs to patient
                   ── no check appointment is checked_in
                   ── no uniqueness per appointment
  PUT  /encounters/:id       ── any writeNote holder, any draft, no authorship check
  PUT  /encounters/:id/vitals── whole-object overwrite, no history
  POST /encounters/:id/signature
                   ── requires signNote + non-lapsed registration
                   ── requires subjective, objective, assessment, plan
                   ── requires ≥1 diagnosis
                   ── DOES NOT touch appointment status
  POST /encounters/:id/addenda ── amendNote, ≥10 chars, no reason field
```

**Optional branches present:** telehealth mode; room-less appointments; nurse-drafted / doctor-signed notes.
**Optional branches absent:** walk-in, triage, queue, guardian, and any practice-level configuration of which steps apply.

---

## 2. Scenario Coverage Table

### Family 1 — New patient registration

| Field | Detail |
|---|---|
| **Scenario ID** | REG-001 |
| **Scenario** | A new patient arrives for the first time; reception searches, confirms they are new, and registers them |
| **Actors** | Receptionist, nurse (both hold `addPatient`), patient |
| **Starting state** | No patient record exists |
| **Expected workflow** | Search → confirm new → capture identity, demographics, contact, cover, emergency contact, consent, allergy status → completeness check → save |
| **Current support** | **PARTIAL** |
| **Missing logic** | Registration cannot capture **medical aid scheme** or **primary provider** in live mode — `createBodyFromForm` in `services/patients.js` sends neither `schemeId` nor `primaryProviderId`, though the server accepts both. Allergy status is never asked at registration; `allergies_reviewed` defaults `false` and no workflow ever sets it. Consent is a bare boolean. |
| **Risk** | **HIGH** |
| **Product decision** | Should registration require cover selection, or is "unknown payer" a legitimate registration state? |

| Field | Detail |
|---|---|
| **Scenario ID** | REG-002 |
| **Scenario** | Reception mistypes a national ID or date of birth and discovers it after saving |
| **Actors** | Receptionist, administrator |
| **Starting state** | Patient registered with an incorrect identity field |
| **Expected workflow** | Correct the field, with the change audited and the previous value retained |
| **Current support** | **MISSING** |
| **Missing logic** | `patients.service.ts` `update()` permits only three field groups. `date_of_birth`, `sex`, `national_id` and `reference` appear in **none** of them. The loop reads `if (!group) continue;` — an unknown column is **silently ignored**, so the API returns success while changing nothing. There is no correction path for a patient's core identity short of direct SQL. |
| **Risk** | **CRITICAL** |
| **Product decision** | Who may correct core identity, and does a correction require a second-person check? |

| Field | Detail |
|---|---|
| **Scenario ID** | REG-003 |
| **Scenario** | A patient later withdraws consent to treatment or to communications |
| **Actors** | Patient, receptionist, administrator |
| **Starting state** | `consent_treatment = true` |
| **Expected workflow** | Record withdrawal with date, actor and reason; prevent further non-emergency activity or flag it |
| **Current support** | **MISSING** |
| **Missing logic** | `consent_treatment`, `consent_comms`, `consent_data_sharing` are plain booleans with no date, version, capture method, capturing user or withdrawal record. `consent_data_sharing` is never written by any code path. Setting the boolean back to false is not even reachable: consent columns are in no `update()` field group. |
| **Risk** | **HIGH** |
| **Product decision** | Is consent a point-in-time event log or a current-state flag? |

### Family 2 — Possible duplicate patient

| Field | Detail |
|---|---|
| **Scenario ID** | DUP-001 |
| **Scenario** | A patient gives the same name and a similar DOB as an existing record, with a different phone |
| **Actors** | Receptionist |
| **Starting state** | One or more similar records exist |
| **Expected workflow** | System surfaces candidate matches before creation; reception confirms or overrides |
| **Current support** | **MISSING** |
| **Missing logic** | No duplicate detection exists anywhere. A repository-wide search for duplicate/match logic returns only unrelated strings. The only uniqueness in the schema is `UNIQUE (practice_id, reference)` on the human-facing patient number, which the client generates. |
| **Risk** | **CRITICAL** |
| **Product decision** | Warn-and-allow, or block on exact identity collision? |

| Field | Detail |
|---|---|
| **Scenario ID** | DUP-002 |
| **Scenario** | Two records are created with the **same national ID** or the **same medical aid membership number** |
| **Actors** | Receptionist |
| **Starting state** | One record exists with that identifier |
| **Expected workflow** | Refused, or explicitly justified |
| **Current support** | **MISSING** |
| **Missing logic** | `patient.national_id` and `patient.member_number` carry **no unique index, partial or otherwise**. Nothing at any layer prevents the collision. |
| **Risk** | **CRITICAL** |
| **Product decision** | Is national ID unique per practice? Zimbabwean practice has to accommodate absent IDs, so a plain `UNIQUE` is not automatically right. |

| Field | Detail |
|---|---|
| **Scenario ID** | DUP-003 |
| **Scenario** | Duplicates already exist and must be merged; both records carry appointments and encounters |
| **Actors** | Administrator, practice manager |
| **Starting state** | Two records, one patient, clinical history split across both |
| **Expected workflow** | Merge with a surviving record, re-pointed children, and a permanent record of the merge |
| **Current support** | **MISSING** |
| **Missing logic** | No merge concept. No `merged_into` column, no merge audit action, no re-parenting path for `appointment`, `encounter`, `prescription`, `lab_result`, `patient_document`, `care_plan`, `referral`. The `tg_touch_and_log` trigger refuses hard deletes, so the losing record cannot even be removed — only tombstoned, which would orphan its clinical history. |
| **Risk** | **CRITICAL** |
| **Product decision** | Must be answered before the first duplicate reaches production, because retrofitting a merge across a tombstone-only model is materially harder later. |

| Field | Detail |
|---|---|
| **Scenario ID** | DUP-004 |
| **Scenario** | Foreign patient with a passport; child with no national ID; patient who has left their ID at home |
| **Actors** | Receptionist |
| **Starting state** | Patient present, no national ID available |
| **Expected workflow** | Register with an explicit identifier type and an explicit "not provided" state |
| **Current support** | **MISSING** |
| **Missing logic** | `nationalId: z.string().min(1)` is **required** at the API. There is no identifier *type* (national ID vs passport vs birth certificate vs none) and no unknown state. The only way through is to type something — see UNK-002. |
| **Risk** | **HIGH** |
| **Product decision** | What identifier set does a Zimbabwean practice actually need, and which are mandatory? |

### Family 3 — Returning patient

| Field | Detail |
|---|---|
| **Scenario ID** | RET-001 |
| **Scenario** | A returning patient is found and their identity confirmed before the chart is opened |
| **Actors** | Receptionist, nurse, doctor |
| **Starting state** | Patient exists |
| **Expected workflow** | Search on several identifiers, confirm identity, open chart |
| **Current support** | **PARTIAL** |
| **Missing logic** | `patient_search_idx` is a GIN index over `full_name || ' ' || reference` only. Searching by phone, national ID or membership number is unsupported or unindexed. There is no identity-confirmation step — opening the chart *is* the confirmation. |
| **Risk** | **MEDIUM** |
| **Product decision** | Should the system require an explicit identity confirmation (e.g. DOB read back) before a chart opens? |

| Field | Detail |
|---|---|
| **Scenario ID** | RET-002 |
| **Scenario** | The patient's medical aid has changed since their last visit |
| **Actors** | Receptionist |
| **Starting state** | Patient has cover A recorded |
| **Expected workflow** | New cover recorded as a new period; historical encounters retain the cover that applied at the time |
| **Current support** | **MISSING** |
| **Missing logic** | Cover is a flat set of columns on `patient` (`scheme_id`, `member_number`, `principal_member`, `dependant_code`, `cover_valid_until`, `cover_status`). Updating them **overwrites** the previous cover with no history and no effective-from date. Migration 021 adds `cover_effective_from`, but as a single scalar — so it records when the *current* cover started, not the periods that preceded it. A patient cannot hold two cover records. |
| **Risk** | **HIGH** |
| **Product decision** | Is cover a one-to-many history keyed by effective period? (Answering "yes" later is a data migration; answering it now is a schema choice.) |

| Field | Detail |
|---|---|
| **Scenario ID** | RET-003 |
| **Scenario** | Reception updates a phone number and address |
| **Actors** | Receptionist |
| **Starting state** | Patient exists |
| **Expected workflow** | Change applied, audited, previous value recoverable |
| **Current support** | **PARTIAL** |
| **Missing logic** | The audit entry records **which columns changed** (`Object.keys(permitted).join(', ')`) but **not the before or after values**. Prior values survive only inside `sync_change.payload`, which is a replication mechanism and not a record anyone can query as history. |
| **Risk** | **MEDIUM** |
| **Product decision** | Should demographic changes carry before/after values in the audit trail? |

### Family 4 — Minor / guardian

| Field | Detail |
|---|---|
| **Scenario ID** | GRD-001 |
| **Scenario** | A parent brings a child for consultation |
| **Actors** | Guardian, child (patient), receptionist, nurse, doctor |
| **Starting state** | Child is new or returning |
| **Expected workflow** | Child record; guardian identified with relationship; guardian holds consent authority; guardian contact separate from emergency contact; medical aid dependant details |
| **Current support** | **MISSING** |
| **Missing logic** | There is **no guardian concept anywhere in the system** — no column, no table, no relationship, no permission, no UI. The only adjacent field is `emergency_relation`, a free-text label on the emergency contact. The consequence is direct: `consentTreatment: z.literal(true)` is recorded against the *child*, so the system asserts a five-year-old consented to their own treatment. `principal_member` and `dependant_code` exist for medical aid but carry no clinical or legal authority and do not link to another patient record. |
| **Risk** | **CRITICAL** |
| **Product decision** | Is a guardian a `patient` linked by a relationship table, a `contact` entity, or a role on an existing person? |

| Field | Detail |
|---|---|
| **Scenario ID** | GRD-002 |
| **Scenario** | The child turns 18 during their history with the practice |
| **Actors** | Patient, administrator |
| **Starting state** | Guardian holds consent authority |
| **Expected workflow** | Authority transfers to the patient at the age of majority; guardian access ends unless separately granted |
| **Current support** | **MISSING** |
| **Missing logic** | No age-derived behaviour exists at all. `date_of_birth` is stored and displayed with a derived age in the chart banner, but nothing in the system branches on it — not consent, not access, not prescribing. |
| **Risk** | **HIGH** |
| **Product decision** | What is the age of majority for consent in this deployment, and is the transition automatic or reviewed? |

| Field | Detail |
|---|---|
| **Scenario ID** | GRD-003 |
| **Scenario** | Separated parents; one guardian must not have access |
| **Actors** | Two guardians, administrator |
| **Starting state** | Child record exists |
| **Expected workflow** | Multiple guardians modelled, each with distinct authority; authority revocable |
| **Current support** | **MISSING** |
| **Missing logic** | One emergency contact, no guardian model, therefore no multiplicity and no revocation. |
| **Risk** | **HIGH** |
| **Product decision** | Does the product support contested-guardianship situations, or is that explicitly out of scope? |

### Family 5 — Incomplete or unknown information

| Field | Detail |
|---|---|
| **Scenario ID** | UNK-001 |
| **Scenario** | Patient arrives with no phone, no address, no emergency contact |
| **Actors** | Receptionist |
| **Starting state** | Patient present and needs to be seen |
| **Expected workflow** | Register with explicit unknown values; visit proceeds; gaps surface for follow-up |
| **Current support** | **MISSING** |
| **Missing logic** | `phone`, `addressCity`, `emergencyName` and `emergencyPhone` are all `z.string().min(1)` — **required**. There is no path to register a patient without them. |
| **Risk** | **HIGH** |
| **Product decision** | Which fields genuinely block registration, and which merely reduce completeness? |

| Field | Detail |
|---|---|
| **Scenario ID** | UNK-002 |
| **Scenario** | Staff enter placeholder data to get past validation |
| **Actors** | Receptionist |
| **Starting state** | Required fields cannot be supplied truthfully |
| **Expected workflow** | An explicit UNKNOWN is available, so nobody has to lie to the system |
| **Current support** | **MISSING — and actively incentivised** |
| **Missing logic** | Because eight fields are hard-required and no unknown state exists, the only way to register a real patient who lacks them is to invent values: `nationalId: "0000000"`, `emergencyPhone: "0000000000"`. The `emergencyPhone !== phone` refinement even forces the two placeholders to differ. Once entered, `recordCompleteness()` in `data/patientRecords.js` counts them as **captured**, so the completeness meter reads 100% for a record that is entirely fabricated. Its only unknown-aware behaviour is treating the literal strings `'—'` and `'Not recorded'` as missing — a convention with no server-side counterpart. |
| **Risk** | **CRITICAL** |
| **Product decision** | Adopt a first-class `UNKNOWN` / `NOT_PROVIDED` value distinct from null, or relax the required set? |

| Field | Detail |
|---|---|
| **Scenario ID** | UNK-003 |
| **Scenario** | Allergy history has never been taken |
| **Actors** | Nurse, doctor |
| **Starting state** | New patient |
| **Expected workflow** | "Never asked" is visibly different from "no known allergies", and there is a workflow to move between them |
| **Current support** | **PARTIAL** |
| **Missing logic** | The **model is correct** — `allergies_reviewed boolean NOT NULL DEFAULT false` alongside `allergies text[]` explicitly separates the two, and the chart banner renders the distinction. The **workflow is absent**: registration never asks, no triage step asks, and `allergies_reviewed` is settable only through the `clinical` field group on `PATCH /patients/:id`, which reception and managers cannot reach. Nothing prompts anyone to review it, and nothing blocks a consultation while it is false. |
| **Risk** | **HIGH** |
| **Product decision** | Should an unreviewed allergy status block prescribing, block signing, or only warn? (See ALG-002.) |

| Field | Detail |
|---|---|
| **Scenario ID** | UNK-004 |
| **Scenario** | An incomplete record needs chasing later |
| **Actors** | Receptionist, practice manager |
| **Starting state** | Patient registered with gaps |
| **Expected workflow** | A worklist of incomplete records with ownership and follow-up |
| **Current support** | **PARTIAL** |
| **Missing logic** | `recordCompleteness()` computes a percentage and a missing list, and the registry shows a completeness column — but that is **client-side only**, computed over 7 `REQUIRED_FIELDS` (`name`, `dob`, `sex`, `nationalId`, `phone`, `addressCity`, `consentTreatment`). The server has no notion of completeness, there is no worklist, no assignment, and no follow-up state. |
| **Risk** | **MEDIUM** |
| **Product decision** | Is completeness an operational task queue or a passive indicator? |

### Family 6 — Walk-in

| Field | Detail |
|---|---|
| **Scenario ID** | WLK-001 |
| **Scenario** | A patient arrives with no appointment and needs to be seen today |
| **Actors** | Receptionist, nurse, doctor |
| **Starting state** | No appointment exists |
| **Expected workflow** | Patient placed in a queue, assigned to a provider or to "next available", seen, documented |
| **Current support** | **MISSING** |
| **Missing logic** | There is **no walk-in concept and no queue**. To see a walk-in, reception must invent an appointment: choose a specific `providerId`, a specific `startsAt`, and a duration — and the exclusion constraint `appointment_provider_no_overlap` will **refuse** it if that provider is already booked at that moment, which for a busy walk-in clinic is most of the day. There is no "next available clinician", no priority, and no unscheduled-visit object. |
| **Risk** | **CRITICAL** |
| **Product decision** | Is a walk-in an appointment with `origin = walk_in`, or a distinct visit object? This is the single largest structural question in Stage 1A, because a large share of Zimbabwean primary-care volume is walk-in. |

| Field | Detail |
|---|---|
| **Scenario ID** | WLK-002 |
| **Scenario** | The clinic wants a queue view: who is waiting, how long, who is next |
| **Actors** | Receptionist, nurse, doctor |
| **Starting state** | Several patients checked in |
| **Expected workflow** | An ordered queue reflecting real waiting state |
| **Current support** | **UI ONLY** |
| **Missing logic** | The "care coordination queue" on the Clinical page is `clinicalQueue` in `data/clinical.js` — a **hardcoded array of seven patient names** with statuses (`Ready`, `Pending`, `Awaiting note`, `Attention`) that exist in no table, map to no appointment status, and never change. It is decorative. There is no derived queue and no waiting-time calculation. |
| **Risk** | **HIGH** |
| **Product decision** | What defines queue order — appointment time, arrival time, triage priority, or manual? |

### Family 7 — Normal appointment

| Field | Detail |
|---|---|
| **Scenario ID** | APT-001 |
| **Scenario** | A patient books ahead by phone |
| **Actors** | Receptionist, patient |
| **Starting state** | Patient exists |
| **Expected workflow** | Capture reason, provider, room, date/time, duration appropriate to the visit type |
| **Current support** | **PARTIAL** |
| **Missing logic** | `visitType` is **free text and optional**, so "Follow up", "follow-up" and "FU" are distinct values and none of them means anything to the system. Duration defaults to 30 minutes with **no relationship to visit type** — a 10-minute dressing change and a 45-minute new-patient consultation are booked identically unless the user overrides by hand. There is no *reason for visit* field distinct from visit type. |
| **Risk** | **MEDIUM** |
| **Product decision** | Should visit type be a configurable per-practice lookup that carries a default duration? |

| Field | Detail |
|---|---|
| **Scenario ID** | APT-002 |
| **Scenario** | A patient is accidentally booked with two different providers at the same time |
| **Actors** | Receptionist |
| **Starting state** | Patient has an appointment at 10:00 with Dr A |
| **Expected workflow** | Refused or warned |
| **Current support** | **MISSING** |
| **Missing logic** | The exclusion constraints protect `provider_id` and `room_id`. There is **no constraint on `patient_id`**, so one patient can hold overlapping appointments with different providers. Nothing warns. |
| **Risk** | **MEDIUM** |
| **Product decision** | Is a patient double-booking always an error, or legitimate (e.g. doctor then physiotherapist back-to-back with overlap tolerance)? |

| Field | Detail |
|---|---|
| **Scenario ID** | APT-003 |
| **Scenario** | A provider is on leave, or a room is closed for maintenance |
| **Actors** | Practice manager, administrator |
| **Starting state** | Provider/room exists |
| **Expected workflow** | Unavailability is representable and blocks booking |
| **Current support** | **MISSING** |
| **Missing logic** | `availability()` in `scheduling.repository.ts` derives free slots from `practice_settings` (`opens_at`, `closes_at`, `slot_minutes`, `open_days`) minus existing appointments. There is **no per-provider working pattern, no leave, no room downtime, and no public-holiday concept**. Every active user is assumed available every opening hour of every open day. `access_grant` with `kind = 'covering'` exists for *chart access* during leave, but nothing marks the provider as not bookable. |
| **Risk** | **HIGH** |
| **Product decision** | Do providers have individual schedules, or does the practice operate one shared timetable? |

| Field | Detail |
|---|---|
| **Scenario ID** | APT-004 |
| **Scenario** | Someone attempts an out-of-order status transition |
| **Actors** | Receptionist |
| **Starting state** | Appointment `booked` |
| **Expected workflow** | Invalid transitions refused with a clear reason |
| **Current support** | **FULL** |
| **Missing logic** | The `NEXT` map in `scheduling.routes.ts` is explicit and the refusal message names the permitted transitions. This is one of the better-modelled parts of Stage 1A. |
| **Risk** | **LOW** |
| **Product decision** | — |

### Family 8 — Reschedule

| Field | Detail |
|---|---|
| **Scenario ID** | RSC-001 |
| **Scenario** | A patient calls and moves their appointment; later, someone asks when it was originally booked |
| **Actors** | Receptionist, patient |
| **Starting state** | Appointment booked for Tuesday 10:00 |
| **Expected workflow** | Same appointment moved, original time preserved, reason recorded, actor and time audited |
| **Current support** | **PARTIAL** |
| **Missing logic** | `schedulingRepository.reschedule()` issues a bare `UPDATE ... SET starts_at = COALESCE($2, starts_at) ...`. The original time is **overwritten and gone**. The audit entry records only the *new* `starts_at` (`[id, moved.visit_type, moved.starts_at]`) — so the trail says an appointment was rescheduled but not from what. **No reason is captured**, and there is no reschedule count, so "this patient has moved their appointment four times" is unanswerable. |
| **Risk** | **HIGH** |
| **Product decision** | Is reschedule an edit with history, or cancel-and-rebook with a link between the two? |

| Field | Detail |
|---|---|
| **Scenario ID** | RSC-002 |
| **Scenario** | Someone reschedules an appointment that is already completed or cancelled |
| **Actors** | Receptionist |
| **Starting state** | Appointment `completed` or `cancelled` |
| **Expected workflow** | Refused |
| **Current support** | **MISSING** |
| **Missing logic** | `PATCH /appointments/:id` has **no status guard**. A `completed` visit — one that already has a signed encounter attached — can have its time, duration, provider and room silently rewritten. A `cancelled` appointment can likewise be moved while remaining cancelled. Note that the exclusion constraints exclude cancelled rows, so moving a cancelled appointment onto an occupied slot succeeds. |
| **Risk** | **HIGH** |
| **Product decision** | Should any field of a finished appointment be editable, and by whom? |

| Field | Detail |
|---|---|
| **Scenario ID** | RSC-003 |
| **Scenario** | An appointment is rescheduled after the patient has already checked in |
| **Actors** | Receptionist |
| **Starting state** | Appointment `checked_in` |
| **Expected workflow** | Either refused, or the check-in is explicitly reversed |
| **Current support** | **AMBIGUOUS** |
| **Missing logic** | The reschedule succeeds and the status stays `checked_in`. The patient is now recorded as physically present for an appointment that is scheduled for next week. |
| **Risk** | **MEDIUM** |
| **Product decision** | Does rescheduling reset status to `booked`? |

### Family 9 — Cancellation

| Field | Detail |
|---|---|
| **Scenario ID** | CAN-001 |
| **Scenario** | A patient cancels; later the practice wants to know who cancelled, when, and why |
| **Actors** | Receptionist, patient, provider |
| **Starting state** | Appointment `booked` |
| **Expected workflow** | Cancellation records reason, party (patient vs clinic), actor and timestamp |
| **Current support** | **PARTIAL** |
| **Missing logic** | `status = 'cancelled'` is the entire record. There is **no `cancellation_reason`, no `cancelled_by`, no `cancelled_at`, and no cancelling-party distinction**. The audit entry captures actor and time (`Visit cancelled`, `booked -> cancelled`) but no reason and no indication of whether the patient or the clinic cancelled — which is the difference between a patient-behaviour metric and a clinic-capacity problem. |
| **Risk** | **HIGH** |
| **Product decision** | What cancellation reasons matter operationally, and must party be recorded? |

| Field | Detail |
|---|---|
| **Scenario ID** | CAN-002 |
| **Scenario** | An appointment is cancelled after check-in, or a cancelled appointment is restored |
| **Actors** | Receptionist |
| **Starting state** | `checked_in`, or `cancelled` |
| **Expected workflow** | Both permitted where reality demands it, with evidence |
| **Current support** | **FULL** (mechanically) / **PARTIAL** (semantically) |
| **Missing logic** | `checked_in → cancelled` and `cancelled → booked` are both permitted transitions and both audited. Cancellation is correctly distinct from deletion — `tg_touch_and_log` refuses hard deletes outright, so cancelled appointments remain visible historically. What is missing is any record of *why* a cancellation was reversed. |
| **Risk** | **LOW** |
| **Product decision** | — |

| Field | Detail |
|---|---|
| **Scenario ID** | CAN-003 |
| **Scenario** | An appointment is cancelled but an encounter was already started against it |
| **Actors** | Receptionist, doctor |
| **Starting state** | Draft encounter linked to the appointment |
| **Expected workflow** | Either blocked, or the draft is explicitly handled |
| **Current support** | **MISSING** |
| **Missing logic** | Nothing connects the two. Cancelling the appointment leaves a live draft encounter pointing at a cancelled visit; conversely, `POST /encounters` will happily create a draft against an appointment that is already `cancelled` or `no_show`, because `createDraft` validates neither the appointment's ownership nor its status. |
| **Risk** | **HIGH** |
| **Product decision** | Should cancellation be refused while an unsigned encounter exists, or should it void the draft? |

### Family 10 — No-show

| Field | Detail |
|---|---|
| **Scenario ID** | NOS-001 |
| **Scenario** | A patient does not arrive and is marked no-show; then arrives 20 minutes later |
| **Actors** | Receptionist |
| **Starting state** | Appointment `booked` |
| **Expected workflow** | No-show is a deliberate act with a threshold; reversible when the patient arrives late |
| **Current support** | **PARTIAL** |
| **Missing logic** | No-show is **entirely manual** — `markNoShow` is a button. There is no time threshold, no automatic transition, and nothing prevents marking someone no-show at 09:01 for a 09:00 appointment. Reversal exists but only as `no_show → booked`, which loses the fact that a no-show was ever recorded, and the patient must then be checked in from `booked`. No reason, context or `no_show_at` timestamp is stored. |
| **Risk** | **MEDIUM** |
| **Product decision** | Is there a grace period, and should reversal preserve the original no-show event? |

| Field | Detail |
|---|---|
| **Scenario ID** | NOS-002 |
| **Scenario** | Reception marks the wrong patient as no-show |
| **Actors** | Receptionist |
| **Starting state** | Two patients on today's list share a name |
| **Expected workflow** | The action targets an unambiguous appointment |
| **Current support** | **MISSING — active defect** |
| **Missing logic** | In `LuminaryDemo.jsx`, both `markNoShow(patient)` and `advanceVisitStatus(patient)` resolve the appointment with `todaysSchedule.find((item) => item.patient === patient)` — **matching on patient display name**. Two patients with the same name, or one patient with two appointments the same day, resolve to whichever row is first in the array. |
| **Risk** | **CRITICAL** |
| **Product decision** | None — this is a defect, not a policy question. |

### Family 11 — Check-in

| Field | Detail |
|---|---|
| **Scenario ID** | CHK-001 |
| **Scenario** | A patient arrives; reception checks them in; the clinical team needs to know they are waiting |
| **Actors** | Receptionist, nurse, doctor |
| **Starting state** | Appointment `booked` |
| **Expected workflow** | Arrival recorded with its own timestamp; patient enters a waiting state visible to clinical staff |
| **Current support** | **PARTIAL** |
| **Missing logic** | **Arrival time is not stored.** The appointment carries `starts_at`, `ends_at`, `created_at` and `updated_at` — nothing records when the patient actually walked in. Waiting time is therefore uncomputable, and "arrived early" is indistinguishable from "arrived 40 minutes late". `updated_at` is not a substitute: any later edit overwrites it. |
| **Risk** | **HIGH** |
| **Product decision** | Should each status transition carry its own timestamp, or is a transition history table the answer? |

| Field | Detail |
|---|---|
| **Scenario ID** | CHK-002 |
| **Scenario** | The same patient is checked in twice, or checked into the wrong appointment |
| **Actors** | Receptionist |
| **Starting state** | Appointment `booked` |
| **Expected workflow** | Double check-in is a no-op or refused; check-in targets one unambiguous appointment |
| **Current support** | **PARTIAL** |
| **Missing logic** | Double check-in **is** correctly refused — `checked_in` is not in `NEXT['checked_in']`, so a repeat returns a 400. But checking into the *wrong* appointment is unguarded: nothing verifies the appointment is for today, and a patient can be checked into next Thursday's appointment from today's screen. Combined with the name-matching defect in NOS-002, the client can select the wrong appointment without the server having any way to tell. |
| **Risk** | **HIGH** |
| **Product decision** | Should check-in be restricted to a date window around `starts_at`? |

| Field | Detail |
|---|---|
| **Scenario ID** | CHK-003 |
| **Scenario** | A patient with a badly incomplete record is checked in |
| **Actors** | Receptionist |
| **Starting state** | Patient registered with gaps |
| **Expected workflow** | Warn, or block, according to policy |
| **Current support** | **MISSING** |
| **Missing logic** | Completeness is computed client-side and displayed; **nothing in the check-in path reads it**. There is no gate at any point of the visit. |
| **Risk** | **MEDIUM** |
| **Product decision** | Does incompleteness ever block progression, and at which step? |

| Field | Detail |
|---|---|
| **Scenario ID** | CHK-004 |
| **Scenario** | Reception needs to distinguish "physically arrived" from "ready to be seen" |
| **Actors** | Receptionist, nurse, doctor |
| **Starting state** | Patient present |
| **Expected workflow** | Arrival, triage-in-progress, triage-complete and waiting-for-doctor are separable |
| **Current support** | **MISSING** |
| **Missing logic** | One `status` column carries six values and is being asked to represent at least four distinct operational concepts: *has the patient physically arrived*, *has triage happened*, *is a clinician currently with them*, and *is the visit administratively finished*. `checked_in` conflates arrival with clinical readiness; `in_consultation` conflates "the doctor has started" with "the note is being written". There is no state between arrival and consultation. |
| **Risk** | **HIGH** |
| **Product decision** | See §3 — this is the central state-model question of Stage 1A. |

### Family 12 — Nurse triage

| Field | Detail |
|---|---|
| **Scenario ID** | TRI-001 |
| **Scenario** | Nurse takes the patient, records vitals and the presenting concern, and marks triage complete |
| **Actors** | Nurse, doctor |
| **Starting state** | Patient `checked_in` |
| **Expected workflow** | Triage is a recognisable step with its own completion state, visible to the doctor |
| **Current support** | **MISSING** |
| **Missing logic** | **There is no triage object, state or step.** For a nurse to record vitals, an *encounter must already exist* — `PUT /encounters/:id/vitals` operates on an encounter id. So the nurse must first call `POST /encounters` (permitted: nurses hold `writeNote`), which creates a draft SOAP note **authored by the nurse**. There is no `triage_complete` flag and no signal to the doctor that triage has happened; the doctor discovers it by opening the draft. The presenting concern has nowhere to live except `subjective`. |
| **Risk** | **CRITICAL** |
| **Product decision** | Is triage a distinct object, a state on the appointment, or a section of the encounter? |

| Field | Detail |
|---|---|
| **Scenario ID** | TRI-002 |
| **Scenario** | Vitals are corrected, or a second set is taken later in the visit |
| **Actors** | Nurse, doctor |
| **Starting state** | Vitals recorded |
| **Expected workflow** | Previous values retained; multiple readings per visit supported |
| **Current support** | **PARTIAL** |
| **Missing logic** | `encounter.vitals` is a single `jsonb` object and `recordVitals()` does a **whole-object overwrite** (`SET vitals = $2, vitals_by = $3`). Only one set of vitals can exist per encounter, and correcting them destroys the original. Positively: vitals are correctly scoped to the **encounter, not the patient**, so they cannot be mistaken for current data on a later visit; `vitals_by` records who took them; and the immutability trigger explicitly includes `vitals`, so they freeze on signing. |
| **Risk** | **MEDIUM** |
| **Product decision** | Are vitals a time series within a visit, or one reading per visit? |

| Field | Detail |
|---|---|
| **Scenario ID** | TRI-003 |
| **Scenario** | The doctor needs to know whether triage is done before calling the patient |
| **Actors** | Doctor, nurse |
| **Starting state** | Patient checked in, triage may or may not be complete |
| **Expected workflow** | A visible handoff signal |
| **Current support** | **MISSING** |
| **Missing logic** | No handoff exists. The appointment status is `checked_in` whether triage has happened or not. The `clinicalQueue` that appears to convey readiness is hardcoded seed data (WLK-002). |
| **Risk** | **HIGH** |
| **Product decision** | What constitutes "ready for the doctor"? |

### Family 13 — Direct-to-doctor practice

| Field | Detail |
|---|---|
| **Scenario ID** | DIR-001 |
| **Scenario** | A two-person practice — receptionist and doctor, no nurse |
| **Actors** | Receptionist, doctor |
| **Starting state** | Patient checked in |
| **Expected workflow** | Patient goes straight to the doctor; the doctor records their own vitals; no triage step is required |
| **Current support** | **FULL by accident, not by design** |
| **Missing logic** | Nothing *requires* a nurse step, so this works — but only because triage does not exist at all (TRI-001). The doctor can record vitals: `recordVitals` is on the encounter and doctors hold `recordVitals`. The problem is the inverse: because there is no configurable workflow, a large clinic that *does* want a mandatory triage step cannot express that either. Neither shape is chosen; both are unmodelled. |
| **Risk** | **MEDIUM** |
| **Product decision** | Should the visit workflow be practice-configurable (which steps exist, which are mandatory)? |

| Field | Detail |
|---|---|
| **Scenario ID** | DIR-002 |
| **Scenario** | The doctor finishes and needs to mark the visit complete themselves |
| **Actors** | Doctor |
| **Starting state** | Appointment `checked_in` or `in_consultation` |
| **Expected workflow** | The clinician can advance their own visit |
| **Current support** | **MISSING — active defect** |
| **Missing logic** | `POST /appointments/:id/status` is guarded by `requirePermission('checkIn')` for **every** transition, including `in_consultation` and `completed`. In `permissions.ts`, `doctor` holds `scheduleVisit` but **not `checkIn`**. A doctor therefore **cannot move any appointment to `in_consultation` or `completed`** — they receive a 403. In a practice with no nurse, only the receptionist can advance the visit, and they must know when the doctor started and finished. This makes the state machine unusable in exactly the small-practice configuration the product needs to serve. |
| **Risk** | **CRITICAL** |
| **Product decision** | Split the permission — front-desk check-in versus clinical progression — or grant `checkIn` to doctors? |

### Family 14 — Consultation

| Field | Detail |
|---|---|
| **Scenario ID** | CON-001 |
| **Scenario** | The doctor opens the patient and documents today's visit |
| **Actors** | Doctor |
| **Starting state** | Patient checked in |
| **Expected workflow** | The note is unambiguously bound to today's appointment |
| **Current support** | **PARTIAL — with a real risk of documenting against the wrong visit** |
| **Missing logic** | `encounter.appointment_id` is **nullable and never validated**: `createDraft` does not check that the appointment belongs to the patient, that it is today, or that it is checked in. Worse, the client's `openNoteForVisit()` in `LuminaryDemo.jsx` does this: `encounters.find(note => note.patientId === patient.id && note.status === DRAFT)`. It reuses **any existing draft for that patient regardless of appointment** — so an abandoned draft from a previous visit is silently reopened for today's consultation, and it still carries the *old* `appointment_id`. Today's clinical content is then written against last month's visit. |
| **Risk** | **CRITICAL** |
| **Product decision** | Should a draft encounter be scoped to one appointment, and what should happen to stale drafts? |

| Field | Detail |
|---|---|
| **Scenario ID** | CON-002 |
| **Scenario** | Two encounters end up attached to one appointment, or an encounter exists with no appointment |
| **Actors** | Doctor, nurse |
| **Starting state** | Appointment exists |
| **Expected workflow** | The cardinality is defined and enforced |
| **Current support** | **AMBIGUOUS** |
| **Missing logic** | No unique index on `encounter.appointment_id`, so many-to-one is possible. `appointment_id` is nullable, so orphan encounters are possible — which is arguably *necessary* (a telephone note, a results review) but the system does not distinguish a deliberately unscheduled encounter from a note whose appointment link was simply never set. `note_type` defaults to `'SOAP note'` and is free text, so it cannot carry that distinction reliably. |
| **Risk** | **MEDIUM** |
| **Product decision** | Is the relationship one-to-one, one-to-many, or is a typed encounter category the answer? |

| Field | Detail |
|---|---|
| **Scenario ID** | CON-003 |
| **Scenario** | A visit involves two clinicians — a nurse takes vitals, a doctor consults, a second doctor is called in |
| **Actors** | Nurse, two doctors |
| **Starting state** | Encounter draft exists |
| **Expected workflow** | Each contribution attributable |
| **Current support** | **PARTIAL** |
| **Missing logic** | `encounter` carries a single `author_id`, plus `vitals_by` and `signed_by`. So three roles are attributable, but no more. If a nurse creates the draft, `author_id` is the **nurse** permanently, even after a doctor writes the entire note and signs it — the note is then authored by someone who did not write it. There is no per-section attribution and no way to record a second consulting clinician. |
| **Risk** | **HIGH** |
| **Product decision** | Should authorship follow whoever wrote each section, or should the signer become the author? |

| Field | Detail |
|---|---|
| **Scenario ID** | CON-004 |
| **Scenario** | The doctor must see allergies and prior history before prescribing |
| **Actors** | Doctor |
| **Starting state** | Chart open |
| **Expected workflow** | Allergies prominent and unambiguous |
| **Current support** | **FULL** |
| **Missing logic** | This is done well. `schedulingRepository.list()` returns `p.allergies, p.allergies_reviewed` **on the day list** — before the chart is even opened — with an explicit comment that a clinician must see it before prescribing rather than after. `clinicalService.get()` joins the same fields onto the note. The chart banner renders "no known allergies" distinctly from "nobody has asked". |
| **Risk** | **LOW** |
| **Product decision** | — |

### Family 15 — Interrupted consultation

| Field | Detail |
|---|---|
| **Scenario ID** | INT-001 |
| **Scenario** | The doctor is called to an emergency mid-note; the workstation locks; they return 40 minutes later |
| **Actors** | Doctor |
| **Starting state** | Draft in progress |
| **Expected workflow** | Draft preserved; session resumes without loss |
| **Current support** | **PARTIAL** |
| **Missing logic** | Draft persistence is real — `PUT /encounters/:id` writes to the database, and the idle lock resumes the *same* session rather than replacing it, so returning does not discard state. What is missing is **autosave**: `saveNote` fires only on an explicit save action, so anything typed since the last save is lost when the browser closes or the network drops. There is no "draft last saved at" indicator. |
| **Risk** | **MEDIUM** |
| **Product decision** | Should clinical drafts autosave, and at what interval? |

| Field | Detail |
|---|---|
| **Scenario ID** | INT-002 |
| **Scenario** | Two clinicians open the same draft and both type |
| **Actors** | Two doctors, or doctor and nurse |
| **Starting state** | One draft encounter |
| **Expected workflow** | Concurrent editing is prevented, merged, or at minimum detected |
| **Current support** | **MISSING** |
| **Missing logic** | `saveDraft()` performs an unconditional `UPDATE ... SET <supplied columns>` with **no optimistic concurrency check** — no version, no `updated_at` precondition, no row lock, no soft lock, no "someone else is editing" indicator. Last write wins and the loser is never told. Because it only writes the columns supplied, two clinicians editing *different* sections will partially merge, producing a note neither of them wrote. Note this is not the replication conflict path — `sync_conflict` covers node-to-node divergence, not two users on the same node. |
| **Risk** | **CRITICAL** |
| **Product decision** | Locking, optimistic versioning, or explicit multi-author sections? |

| Field | Detail |
|---|---|
| **Scenario ID** | INT-003 |
| **Scenario** | A doctor leaves a draft open and another clinician needs to see the patient |
| **Actors** | Two doctors |
| **Starting state** | Draft owned by doctor A |
| **Expected workflow** | Visible ownership; deliberate handover |
| **Current support** | **MISSING** |
| **Missing logic** | `saveDraft()` checks only `can(actor.role, 'writeNote')`. **Any** doctor or nurse in the practice may edit **any** draft, with no authorship check and no handover record. `author_id` does not change, so the edit is invisible in attribution. |
| **Risk** | **HIGH** |
| **Product decision** | May a clinician edit another's draft, and should it be recorded as a handover? |

### Family 16 — Incomplete clinical note

| Field | Detail |
|---|---|
| **Scenario ID** | SGN-001 |
| **Scenario** | The doctor tries to sign a note that is missing sections |
| **Actors** | Doctor |
| **Starting state** | Incomplete draft |
| **Expected workflow** | Refused, naming exactly what is missing |
| **Current support** | **FULL** |
| **Missing logic** | `sign()` filters `REQUIRED_TO_SIGN = ['subjective','objective','assessment','plan']` and returns `missing: <list>`, then separately requires `diagnoses.length > 0`. The message is specific and actionable. |
| **Risk** | **LOW** |
| **Product decision** | — |

| Field | Detail |
|---|---|
| **Scenario ID** | SGN-002 |
| **Scenario** | A nurse-only dressing change; a procedure-only visit; a repeat-prescription review; an administrative note |
| **Actors** | Nurse, doctor |
| **Starting state** | Short or non-SOAP clinical interaction |
| **Expected workflow** | An encounter template appropriate to the interaction |
| **Current support** | **MISSING** |
| **Missing logic** | `REQUIRED_TO_SIGN` is a hardcoded module constant. **Every** encounter must have all four SOAP sections plus a coded diagnosis before it can be signed. A wound-dressing check has no meaningful "assessment"; a repeat script has no "objective"; an administrative note has neither. `note_type` is a free-text column that **nothing branches on** — it is stored, displayed, and otherwise ignored. The practical consequence is that clinicians will pad sections with filler text to get past the gate, which degrades every note in the system. |
| **Risk** | **HIGH** |
| **Product decision** | Should encounter types be first-class, each with its own required-section set? |

| Field | Detail |
|---|---|
| **Scenario ID** | SGN-003 |
| **Scenario** | A nurse writes a note that legitimately never needs a doctor's signature |
| **Actors** | Nurse |
| **Starting state** | Nurse-authored draft |
| **Expected workflow** | The note can reach a finished state |
| **Current support** | **MISSING** |
| **Missing logic** | Nurses hold `writeNote` but **not `signNote`**. There is no other terminal state for an encounter — `status` is constrained to `draft | signed | amended`. A nurse-only interaction therefore **cannot ever be completed**; it remains a draft indefinitely, and a permanent draft is indistinguishable from an abandoned one. |
| **Risk** | **HIGH** |
| **Product decision** | Do nurse-authored notes need countersignature, their own completion state, or nurse signing rights for defined types? |

### Family 17 — Allergy conflict

| Field | Detail |
|---|---|
| **Scenario ID** | ALG-001 |
| **Scenario** | The clinician prescribes a drug the patient is recorded as allergic to |
| **Actors** | Doctor |
| **Starting state** | Allergy recorded |
| **Expected workflow** | Blocked or warned, according to explicit policy, with a safe override route |
| **Current support** | **PARTIAL — blocked with no override** |
| **Missing logic** | `prescribe()` **hard-refuses** with a 409 naming the allergy. There is **no override mechanism at all** — no "override with reason", no senior authorisation, nothing. The only way to proceed is for someone with `editClinicalHistory` to **edit the allergy off the patient record**, which destroys the clinical fact in order to work around the control. That is the worst available outcome: the system converts a documented allergy into a deleted one. Additionally, the matcher is crude: it splits each allergy on non-letters and matches any word longer than three characters as a substring of the drug name, so "Penicillin" blocks "Penicillamine", while a class allergy (e.g. sulfa drugs) does not match a specific member. |
| **Risk** | **CRITICAL** |
| **Product decision** | Hard block or override-with-reason? Clinical practice generally requires the latter with mandatory justification and audit. |

| Field | Detail |
|---|---|
| **Scenario ID** | ALG-002 |
| **Scenario** | Allergy status has never been reviewed and the clinician prescribes |
| **Actors** | Doctor |
| **Starting state** | `allergies_reviewed = false` |
| **Expected workflow** | The clinician is told the status is unknown, not that there are no allergies |
| **Current support** | **MISSING** |
| **Missing logic** | `prescribe()` reads `allergies_reviewed` in its SELECT but **never uses it** — the only check is against the `allergies` array, which is empty. So an unreviewed patient behaves identically to one confirmed to have no allergies: prescribing proceeds silently. The data model makes the distinction; the safety logic ignores it. |
| **Risk** | **CRITICAL** |
| **Product decision** | Should unreviewed allergy status warn, block prescribing, or block signing? |

### Family 18 — Wrong patient / wrong chart

| Field | Detail |
|---|---|
| **Scenario ID** | WRG-001 |
| **Scenario** | A clinician opens a patient with a similar name and begins documenting |
| **Actors** | Doctor, nurse |
| **Starting state** | Two similarly named patients |
| **Expected workflow** | Strong identifying information stays visible; a confirmation step exists before signing |
| **Current support** | **PARTIAL** |
| **Missing logic** | The chart banner does carry identity, cover and allergies, and the registry shows a patient reference. But the **encounter note itself** has no patient-identity confirmation step, and `sign()` performs **no identity re-confirmation** — it validates completeness and authority only. Signing is the point of no return and it asks nothing about *who* the note is for. |
| **Risk** | **HIGH** |
| **Product decision** | Should signing require an explicit patient confirmation (name + DOB shown, actively acknowledged)? |

| Field | Detail |
|---|---|
| **Scenario ID** | WRG-002 |
| **Scenario** | The error is discovered **after** the note is signed |
| **Actors** | Doctor, administrator |
| **Starting state** | Signed note on the wrong patient |
| **Expected workflow** | The note is retracted or reassigned, both charts are corrected, and the full history is preserved |
| **Current support** | **MISSING** |
| **Missing logic** | There is **no retraction, reassignment or void mechanism**. `encounter.patient_id` is in no editable set; `saveDraft` restricts writes to `note_type, subjective, objective, assessment, plan, follow_up, diagnoses`; the immutability trigger blocks content change on a signed note; and hard deletes are refused by trigger. The only available action is an addendum saying "this note relates to a different patient" — which leaves the incorrect clinical content permanently attached to the wrong chart, visible to every future clinician who opens it. This is the highest-severity clinical-safety gap in Stage 1A. |
| **Risk** | **CRITICAL** |
| **Product decision** | What is the retraction model — a `retracted` status with a mandatory reason, a reassignment with dual-chart audit, or an administrator-only void? |

| Field | Detail |
|---|---|
| **Scenario ID** | WRG-003 |
| **Scenario** | A receptionist opens a chart they have no clinical reason to see |
| **Actors** | Receptionist |
| **Starting state** | Any patient in the practice |
| **Expected workflow** | Access is accountable |
| **Current support** | **AMBIGUOUS — by design, but worth restating** |
| **Missing logic** | `care_relationship()` returns `'practice staff'` for **every non-doctor role**, unconditionally. Break-glass therefore applies **only to doctors**. A receptionist, nurse or manager can open any chart in the practice with no reason required. The access *is* audited (`log_chart_access` writes a `Viewed chart` entry), so this is accountability rather than prevention — consistent with the stated philosophy — but it means the break-glass control that the product markets covers one of five roles. Separately, the `'booked with you'` branch grants a doctor access from **any appointment ever**, with no status or recency filter: a visit cancelled two years ago grants permanent access today. |
| **Risk** | **MEDIUM** |
| **Product decision** | Should non-doctor chart access require a relationship, and should stale appointments expire as a basis for access? |

### Family 19 — Signing the encounter

| Field | Detail |
|---|---|
| **Scenario ID** | SGN-004 |
| **Scenario** | The doctor signs; the record must show who signed and when |
| **Actors** | Doctor |
| **Starting state** | Complete draft |
| **Expected workflow** | Signature attributable, immutable, and meaningfully distinct from saving |
| **Current support** | **FULL** |
| **Missing logic** | Signing is clearly distinct from saving; `signed_by` comes from the session, never the body; `signed_at` is set by the database; the `signature_consistent` CHECK constraint guarantees a signed note carries a signature and a draft does not; `tg_encounter_immutable` freezes the content. This is enforced at three layers as designed. |
| **Risk** | **LOW** |
| **Product decision** | — |

| Field | Detail |
|---|---|
| **Scenario ID** | SGN-005 |
| **Scenario** | Doctor B signs a note drafted by Doctor A |
| **Actors** | Two doctors |
| **Starting state** | Doctor A's draft |
| **Expected workflow** | Either refused, or recorded as a countersignature |
| **Current support** | **AMBIGUOUS** |
| **Missing logic** | `sign()` checks the `signNote` permission and registration validity — **not authorship, and not any care relationship**. Any doctor in the practice can sign any draft. When the signer differs from the author, the record shows both (`author_name`, `signed_by_name`) but does not characterise the act: it is indistinguishable from a supervisor countersigning a registrar, a locum finishing a colleague's work, and a mistake. |
| **Risk** | **HIGH** |
| **Product decision** | Is cross-signing permitted, and is countersignature a distinct concept? |

| Field | Detail |
|---|---|
| **Scenario ID** | SGN-006 |
| **Scenario** | A clinician's registration lapses between drafting and signing |
| **Actors** | Doctor, administrator |
| **Starting state** | Draft written while registered; registration now lapsed |
| **Expected workflow** | Signing blocked; the draft is not lost; someone can resolve it |
| **Current support** | **PARTIAL** |
| **Missing logic** | The block works — `sign()` refuses on `actor.registrationLapsed`, and drafting and reading remain permitted, which is the right balance. What is missing is **resolution**: the draft is stranded. There is no supervisor countersignature route and no queue of blocked notes. The organisation module surfaces expiring registrations, but nothing links a lapse to the drafts it has frozen. |
| **Risk** | **MEDIUM** |
| **Product decision** | Who signs off notes stranded by a lapse? |

### Family 20 — Post-sign correction

| Field | Detail |
|---|---|
| **Scenario ID** | ADD-001 |
| **Scenario** | The doctor spots an error seconds after signing |
| **Actors** | Doctor |
| **Starting state** | Signed note |
| **Expected workflow** | Original preserved; correction appended with actor, time and reason |
| **Current support** | **PARTIAL** |
| **Missing logic** | The core is right: the original is immutable, addenda are separate rows carrying `author_id` and `created_at`, multiple addenda are supported, and status moves to `amended`. Two gaps: (1) an addendum has **no reason or correction-type field** — just `body`, minimum 10 characters, so "why" is only present if the author happens to type it; (2) there is **no grace period or unsign**, so a genuine slip of the mouse one second after signing is permanently a signed note plus a correction, which is arguably correct medico-legally but should be a deliberate decision rather than an accident of implementation. |
| **Risk** | **MEDIUM** |
| **Product decision** | Should addenda carry a structured reason? Should a short unsign window exist? |

| Field | Detail |
|---|---|
| **Scenario ID** | ADD-002 |
| **Scenario** | An addendum itself contains an error |
| **Actors** | Doctor |
| **Starting state** | Addendum exists |
| **Expected workflow** | Correctable without destroying history |
| **Current support** | **MISSING** |
| **Missing logic** | `encounter_addendum` has **no immutability trigger** and no update route. It is a tenant table, so `luminary_app` holds `UPDATE` on it — meaning an addendum is silently editable at the SQL layer while being unreachable through the API. Neither "safely correctable" nor "genuinely immutable". The only available action is a further addendum correcting the previous one, with nothing linking them. |
| **Risk** | **MEDIUM** |
| **Product decision** | Are addenda immutable? If so it should be enforced, as it is for the encounter itself. |

| Field | Detail |
|---|---|
| **Scenario ID** | ADD-003 |
| **Scenario** | A future clinician reads the chart and needs to understand what was corrected and when |
| **Actors** | Doctor |
| **Starting state** | Note with several addenda |
| **Expected workflow** | A clear chronological account |
| **Current support** | **PARTIAL** |
| **Missing logic** | `clinicalService.get()` returns addenda ordered by `created_at` with author names, and the list view shows an addendum count — legible. But once a note is `amended`, further addenda leave the status unchanged, so "amended once" and "amended six times" look identical at a glance; and because addenda have no reason field, the timeline shows *that* something changed without reliably showing *why*. |
| **Risk** | **LOW** |
| **Product decision** | — |

### Family 21 — Encounter completion

| Field | Detail |
|---|---|
| **Scenario ID** | CLS-001 |
| **Scenario** | The doctor signs the note and the patient leaves |
| **Actors** | Doctor, receptionist |
| **Starting state** | Appointment `in_consultation`, note signed |
| **Expected workflow** | The visit reaches a single, unambiguous finished state |
| **Current support** | **MISSING** |
| **Missing logic** | **Signing does not touch the appointment.** `clinicalService.sign()` updates only the encounter; `signNote` in `LuminaryDemo.jsx` calls `saveDraft` then `sign` then `liveWorkspace.reload()` — it never calls `api.appointments.setStatus`. So the normal end-of-consultation outcome is `encounter.status = 'signed'` with `appointment.status = 'checked_in'` or `'in_consultation'`. The patient stays on today's active list forever unless someone remembers to advance the appointment separately — and per DIR-002 the **doctor cannot do it**, because advancing requires `checkIn`. There is no reconciliation, no warning, and no view of visits left open. |
| **Risk** | **CRITICAL** |
| **Product decision** | Does signing complete the visit, or is administrative closure a separate deliberate act? |

| Field | Detail |
|---|---|
| **Scenario ID** | CLS-002 |
| **Scenario** | A visit is marked completed but no note was ever written |
| **Actors** | Receptionist |
| **Starting state** | Appointment `in_consultation` |
| **Expected workflow** | Either blocked, or flagged as undocumented |
| **Current support** | **MISSING** |
| **Missing logic** | `in_consultation → completed` performs no check for an encounter, and certainly not for a *signed* one. A visit can be closed with no clinical record and nothing indicates it. The inverse also holds: nothing lists signed notes whose appointment is still open. There is no "undocumented visit" report — the closest thing, the organisation module's unsigned-note count, is used only to block deactivating a clinician. |
| **Risk** | **HIGH** |
| **Product decision** | Should completion require a signed encounter, warn, or simply flag for later? |

---

## 3. Missing Workflow States

Each state below is justified by at least one scenario above. **These are observations, not instructions to implement.**

### 3.1 Visit / appointment states

| Proposed state | Justified by | Why the current model cannot express it |
|---|---|---|
| `arrived` (distinct from `checked_in`) | CHK-001, CHK-004 | No arrival timestamp exists; `checked_in` conflates physical presence with clinical readiness |
| `waiting_for_triage` | TRI-001, TRI-003 | Nothing distinguishes a patient who has just arrived from one waiting for a nurse |
| `triage_complete` / `waiting_for_doctor` | TRI-003, DIR-001 | The doctor has no signal that triage is done; the queue that appears to convey this is hardcoded |
| `documentation_pending` | CLS-001, CLS-002 | The gap between the patient leaving and the note being signed is invisible |
| `closed` vs `completed` | CLS-001 | One value is asked to mean both "the clinical work is finished" and "the visit is administratively closed" |
| `retracted` (appointment created in error) | DUP-003, NOS-002 | Only `cancelled` exists, which means something different to a patient who cancelled |

### 3.2 Encounter states

| Proposed state | Justified by | Why |
|---|---|---|
| `completed` for non-signable notes | SGN-003 | A nurse-authored note has no terminal state and stays a draft forever |
| `awaiting_countersignature` | SGN-005, SGN-006 | Cross-signing and lapse-stranded drafts have no representation |
| `retracted` / `voided` | WRG-002 | Wrong-patient documentation cannot be withdrawn |
| `abandoned` | CON-001 | Stale drafts are silently reused for later visits |

### 3.3 Patient-record states

| Proposed state | Justified by | Why |
|---|---|---|
| `UNKNOWN` / `NOT_PROVIDED` as a field value | UNK-001, UNK-002, DUP-004 | Required fields with no unknown state force fabricated data |
| `provisional` / `unverified` registration | UNK-001, WLK-001 | A walk-in registered in 30 seconds is indistinguishable from a fully verified record |
| `merged_into` | DUP-003 | Duplicates cannot be resolved |
| Consent as a dated, versioned event | REG-003 | A boolean cannot express when, how, by whom, or withdrawal |

---

## 4. Missing Actions

Actions a user realistically needs that the system cannot represent:

1. **Search for possible duplicates** before creating a patient (DUP-001).
2. **Merge two patient records**, re-pointing all clinical children (DUP-003).
3. **Correct a date of birth, sex, national ID or patient reference** — currently impossible through the API (REG-002).
4. **Record or withdraw consent as an event**, with date, method and version (REG-003).
5. **Register a guardian** and record who holds consent authority (GRD-001).
6. **Record an unknown value explicitly** rather than a blank or a placeholder (UNK-002).
7. **Create a walk-in visit** without inventing a time slot on a booked provider (WLK-001).
8. **Assign to "next available clinician"** (WLK-001).
9. **See a real waiting queue** derived from actual state (WLK-002).
10. **Record a cancellation reason and party** (CAN-001).
11. **Reschedule with a reason, preserving the original time** (RSC-001).
12. **Mark a provider unavailable** — leave, half-day, room downtime (APT-003).
13. **Complete triage as a distinct, visible act** (TRI-001).
14. **Record a second set of vitals** in the same visit (TRI-002).
15. **Advance the visit as the treating doctor** — currently a 403 (DIR-002).
16. **Sign an encounter that is not a full SOAP note** (SGN-002).
17. **Complete a nurse-only note** (SGN-003).
18. **Override an allergy block with a documented reason** (ALG-001).
19. **Retract or reassign a note signed against the wrong patient** (WRG-002).
20. **Correct an addendum** (ADD-002).
21. **See visits that are clinically finished but administratively open** (CLS-001).
22. **See completed visits with no clinical documentation** (CLS-002).

---

## 5. Missing Relationships

| Relationship | Required by | Current state |
|---|---|---|
| `guardian ↔ patient` (typed, multiple, revocable, with consent authority) | GRD-001/2/3 | **Absent entirely.** Nearest is `emergency_relation`, a free-text label |
| `patient ↔ cover period` (one-to-many, effective-dated) | RET-002 | **Absent.** Cover is flat columns overwritten in place |
| `appointment ↔ encounter` (defined cardinality, validated) | CON-001, CON-002, CLS-001 | Nullable FK, no uniqueness, never validated for patient or status |
| `triage ↔ encounter` | TRI-001 | **Absent.** Triage does not exist as an object |
| `appointment ↔ status transition history` | CHK-001, RSC-001, CAN-001, NOS-001 | **Absent.** Only a current status; prior values overwritten |
| `patient ↔ patient` (merge lineage) | DUP-003 | **Absent** |
| `encounter ↔ multiple contributing clinicians` | CON-003 | Only `author_id`, `vitals_by`, `signed_by` |
| `addendum ↔ the addendum it corrects` | ADD-002 | **Absent** |
| `provider ↔ availability / leave` | APT-003 | **Absent.** `access_grant.covering` covers chart access, not bookability |
| `allergy ↔ override event` | ALG-001 | **Absent** |

---

## 6. Missing Validation Rules

| # | Rule | Currently |
|---|---|---|
| V1 | A patient's national ID should be unique within a practice, or explicitly marked absent | No constraint, no absent state |
| V2 | A membership number should be unique per scheme unless a dependant code differs | No constraint |
| V3 | A minor must have a guardian recorded before consent is valid | No age logic, no guardian |
| V4 | An encounter's appointment must belong to the same patient | Never checked |
| V5 | An encounter should not be created against a `cancelled` or `no_show` appointment | Never checked |
| V6 | An appointment should not be rescheduled once `completed` or `cancelled` | No status guard |
| V7 | Rescheduling a `checked_in` appointment should reset or refuse | Neither |
| V8 | A patient should not hold overlapping appointments | No constraint |
| V9 | Check-in should be bounded to a window around `starts_at` | Unbounded |
| V10 | Completing a visit should require (or flag the absence of) a signed encounter | Never checked |
| V11 | Signing should require an unreviewed allergy status to be resolved | `allergies_reviewed` is read but unused |
| V12 | Required note sections should vary by encounter type | Hardcoded SOAP for all |
| V13 | Concurrent draft edits should be detected | No versioning, no lock |
| V14 | A draft should belong to one appointment and not be reused across visits | Client reuses any draft for the patient |
| V15 | An allergy override should require a documented reason | No override exists |
| V16 | Consent must exist and be current before clinical activity | Checked once at registration, never re-checked, never expires |
| V17 | A stale appointment should not confer indefinite chart access | `'booked with you'` has no status or recency filter |
| V18 | Unknown columns in a patient PATCH should be rejected, not ignored | `if (!group) continue;` silently discards them |

---

## 7. Workflow Contradictions

State combinations the architecture can currently produce that should not logically coexist. **Each is verified against the code, not assumed.**

| # | Contradiction | How it arises | Severity |
|---|---|---|---|
| C1 | `encounter = signed` **and** `appointment = checked_in` | `sign()` never touches the appointment; the client never calls `setStatus` after signing. This is the **normal** outcome, not an edge case | **CRITICAL** |
| C2 | `appointment = completed` **and** no encounter exists | `in_consultation → completed` checks nothing | HIGH |
| C3 | `appointment = cancelled` **and** a live draft encounter is attached | Nothing links cancellation to encounters; `createDraft` accepts a cancelled appointment | HIGH |
| C4 | `appointment = checked_in` **and** `starts_at` is next week | `PATCH /appointments/:id` has no status guard (RSC-003) | HIGH |
| C5 | `appointment = completed` **and** its time/provider/room subsequently changed | Same missing guard (RSC-002) | HIGH |
| C6 | `encounter.appointment_id` points at a **different patient's** appointment | `createDraft` never validates ownership | HIGH |
| C7 | Two `signed` encounters against one appointment | No uniqueness on `appointment_id` | MEDIUM |
| C8 | `encounter.author_id` = nurse, entire note written and signed by a doctor | `author_id` set at creation, never updated | MEDIUM |
| C9 | `allergies_reviewed = false` **and** a prescription issued with no warning | `prescribe()` reads the flag and ignores it | **CRITICAL** |
| C10 | Patient `status = 'New'` indefinitely after many visits | `patient.status` is free text, defaults `'New'`, and no code path ever updates it | LOW |
| C11 | Two patient records with the same national ID, each holding half the clinical history | No uniqueness, no merge | **CRITICAL** |
| C12 | `consent_treatment = true` recorded against an infant | No age logic, no guardian model | HIGH |
| C13 | A signed note permanently attached to the wrong patient | No retraction or reassignment path | **CRITICAL** |
| C14 | Nurse-authored note stuck in `draft` forever | Nurses lack `signNote`; no other terminal state | HIGH |

---

## 8. Practice-Model Assumptions

Assumptions baked into the implementation that could prevent Luminary working across practice types:

| # | Assumption | Where it lives | Practice type it breaks |
|---|---|---|---|
| A1 | **Every patient has a national ID** | `nationalId: z.string().min(1)` | Paediatrics, refugee/migrant care, tourist and expatriate practice, any patient without documents |
| A2 | **Every patient is an adult who consents for themselves** | `consentTreatment: z.literal(true)` on the patient record; no guardian model | Paediatrics, geriatrics with impaired capacity, any practice seeing minors |
| A3 | **Every patient books before arriving** | No walk-in object; appointments require a provider and a time slot; exclusion constraints refuse doubling up | General practice, urgent care, rural clinics — the majority of Zimbabwean primary-care volume |
| A4 | **Every clinical interaction is a full SOAP note with a coded diagnosis** | `REQUIRED_TO_SIGN` is a module constant | Dressing clinics, immunisation sessions, repeat-prescription reviews, physiotherapy, dentistry, procedure-only visits |
| A5 | **Only doctors finish clinical documentation** | `signNote` granted to `doctor` alone; no other terminal encounter state | Nurse-led clinics, midwifery, community health posts |
| A6 | **Front-desk staff, not clinicians, drive visit progression** | `POST /appointments/:id/status` requires `checkIn`, which doctors do not hold | Any practice where the doctor calls their own patient — i.e. most small practices |
| A7 | **Every provider is available every opening hour of every open day** | `availability()` reads only practice-level `opens_at`/`closes_at`/`open_days` | Any practice with part-time clinicians, sessional specialists, leave, or split sites |
| A8 | **One patient, one current medical aid, no history** | Flat cover columns overwritten in place | Any practice where cover changes — i.e. all of them, given Zimbabwean scheme volatility |
| A9 | **Every patient has a phone, an address and an emergency contact** | All four fields `min(1)` | Rural practice, homeless and transient patients, elderly patients living alone |
| A10 | **A visit involves exactly one clinician** | Single `author_id`; no multi-clinician model | Teaching practices, supervised registrars, multidisciplinary visits |
| A11 | **Two clinicians never edit the same note** | No concurrency control of any kind | Any practice with shared workstations or a nurse-then-doctor flow |
| A12 | **A recorded allergy is always correct and never needs overriding** | Hard block, no override | All clinical practice; overrides are routine and normally require documentation, not deletion |
| A13 | **The patient identified at the door is the patient in the chart** | No identity confirmation at chart open or at signing | Any practice with common surnames — acute in Zimbabwe, where a small set of surnames is very widely shared |
| A14 | **Non-doctor staff need no care relationship** | `care_relationship()` returns `'practice staff'` for four of five roles | Larger practices where a receptionist has no business opening a specific chart |

---

## 9. Top 10 Logic Gaps

Ranked by clinical and operational consequence, restricted to workflow logic rather than infrastructure.

| Rank | Gap | Scenarios | Why it ranks here |
|---|---|---|---|
| **1** | **A signed note cannot be retracted or reassigned.** Documentation written against the wrong patient is permanent and visible to every future clinician. | WRG-002, C13 | Directly causes clinical harm. The immutability design is right; the *absence of a legitimate correction path* is what makes it dangerous. A patient can be treated on the basis of another patient's note |
| **2** | **Signing does not complete the visit, and the doctor cannot complete it either.** `encounter = signed` with `appointment = checked_in` is the normal outcome, and advancing requires a permission doctors do not hold. | CLS-001, DIR-002, C1 | The clinical/front-desk lifecycle never closes cleanly. Every visit leaves a dangling object, and the one person who knows the consultation ended is refused permission to say so |
| **3** | **No duplicate detection, no uniqueness, no merge.** | DUP-001/2/3, C11 | Every duplicate splits a clinical history in two, and the tombstone-only model means the damage compounds and cannot currently be undone. This gets structurally harder every day the system holds real data |
| **4** | **No guardian model; minors consent for themselves.** | GRD-001/2/3, C12 | Any practice seeing children cannot be operated lawfully or safely. Legal authority is entirely unmodelled |
| **5** | **Walk-ins are unrepresentable, and the queue is decorative.** | WLK-001, WLK-002 | A large share of the target market's daily volume cannot be recorded without fabricating appointments, and the exclusion constraints actively refuse the workaround |
| **6** | **Unreviewed allergy status is silently treated as "no allergies" when prescribing.** | ALG-002, C9 | The schema makes the distinction deliberately and the safety check ignores it. A patient nobody has asked is treated exactly like one confirmed safe |
| **7** | **Allergy blocks have no override, so the workaround is deleting the allergy.** | ALG-001 | A safety control whose only bypass is destroying the clinical fact is worse than a warning. This will happen in practice |
| **8** | **No triage step and no clinical handoff.** Recording vitals requires creating a SOAP draft; nothing signals the doctor. | TRI-001, TRI-003, C8 | The nurse→doctor handoff — the most common interaction in a staffed clinic — has no representation, and the workaround corrupts note authorship |
| **9** | **No concurrency control on drafts; any clinician may edit any draft.** | INT-002, INT-003 | Silent partial merges producing a note neither clinician wrote, with no detection and no warning. Clinical content is lost invisibly |
| **10** | **Reschedule, cancellation and no-show record no reason and no history.** Original appointment times are overwritten. | RSC-001, CAN-001, NOS-001 | The operational history the practice needs to manage capacity and patient behaviour is destroyed at the moment it is created |

*Runners-up, close behind:* core patient identity (DOB, sex, national ID) is uncorrectable through the API, with unknown fields silently discarded (REG-002, V18); required fields with no UNKNOWN state actively incentivise fabricated data that then reads as 100% complete (UNK-002); the client resolves appointments by patient **name** for no-show and status advancement (NOS-002); and one encounter template is forced onto every clinical interaction (SGN-002).

---

## 10. Questions Luminary Must Decide

These are product and business decisions, not defects. Each changes what the correct implementation would be, so none should be settled silently.

### Identity and records
1. Should national ID be unique per practice, given that patients legitimately arrive without one?
2. What identifier types must the system support — national ID, passport, birth certificate, driver's licence, none — and which are mandatory?
3. Should duplicate detection **warn and allow**, or **block** on an exact identity collision?
4. What is the merge model: which record survives, what happens to the loser, and who is permitted to merge?
5. Who may correct core identity fields (DOB, sex, national ID, patient reference), and does a correction require second-person authorisation?
6. Should demographic audit entries carry before/after values, or only the names of changed fields?

### Consent and authority
7. Is consent a **current-state flag** or a **dated, versioned event log**?
8. Must consent be re-confirmed periodically, and does it expire?
9. Is a guardian a `patient` linked by a relationship table, a distinct contact entity, or a role?
10. How many guardians may a patient have, and can authority be revoked from one but not another?
11. What is the age of majority for consent in this deployment, and is the transition automatic or reviewed?
12. Does a guardian have any right to view the chart, distinct from being an emergency contact?

### Unknown data
13. Should the system adopt a first-class `UNKNOWN` / `NOT_PROVIDED` value distinct from null and blank?
14. Which registration fields genuinely block registration, and which merely reduce completeness?
15. Is record completeness a passive indicator or an operational worklist with ownership and follow-up?
16. Should incompleteness ever block progression — at check-in, at consultation, at signing?

### Scheduling
17. **Should a walk-in always create an appointment record, even when the patient is seen immediately?**
18. If so, how does a walk-in bypass the provider overlap constraint — a nominal slot, an unscheduled flag, or a separate visit object?
19. What defines queue order: appointment time, arrival time, triage priority, or manual arrangement?
20. Should visit type be a configurable per-practice lookup carrying a default duration?
21. Do providers have individual working patterns and leave, or does the practice run one shared timetable?
22. Is a patient double-booking always an error, or sometimes legitimate?
23. Is reschedule an **edit with history**, or **cancel-and-rebook with a link**?
24. Should any field of a `completed` or `cancelled` appointment remain editable, and by whom?
25. Does rescheduling a `checked_in` appointment reset the status?
26. Is there a no-show grace period, and should reversing a no-show preserve the original event?
27. Should check-in be restricted to a date window around the appointment time?

### Clinical workflow
28. Is triage a distinct object, a state on the appointment, or a section of the encounter?
29. Are vitals a time series within a visit, or one reading per visit?
30. Should the visit workflow be **practice-configurable** — which steps exist and which are mandatory?
31. Should the check-in permission be split into front-desk check-in versus clinical progression?
32. Should encounter types be first-class, each with its own required-section set?
33. Do nurse-authored notes need countersignature, their own completion state, or nurse signing rights for defined types?
34. Is a draft encounter scoped to exactly one appointment, and what happens to stale drafts?
35. Should authorship follow whoever wrote each section, or should the signer become the author?
36. May a clinician edit another clinician's draft, and should that be recorded as a handover?
37. Concurrency: locking, optimistic versioning, or explicitly multi-author sections?
38. Should clinical drafts autosave, and at what interval?

### Clinical safety
39. **Is an allergy conflict a hard block or an override-with-documented-reason?**
40. Should an unreviewed allergy status warn, block prescribing, or block signing?
41. Should signing require explicit patient identity confirmation?
42. What is the retraction model for a note signed against the wrong patient — a `retracted` status, reassignment with dual-chart audit, or an administrator-only void?
43. Should a short unsign grace period exist immediately after signing?
44. Are addenda immutable? If so, should that be enforced as it is for encounters?
45. Should addenda carry a structured correction reason?

### Access and closure
46. Should non-doctor roles require a care relationship, or is practice-wide access with audit the intended policy?
47. Should a stale or cancelled appointment stop conferring chart access after some period?
48. Does signing complete the visit, or is administrative closure a separate deliberate act?
49. Should marking a visit complete require a signed encounter, warn, or simply flag it?
50. Who resolves drafts stranded by a clinician's lapsed registration?

---

## Stop Condition

This audit ends at encounter completion, as scoped. Billing, payments, claims, pharmacy dispensing, insurance adjudication, messaging campaigns, reporting, finance, NH263 and all external integrations were **not** examined and are reserved for later stages. No test scenarios were generated and no remediation was designed.

---

## Read-Only Confirmation

> This scenario audit was performed without creating, editing, deleting, renaming, patching, reformatting or otherwise modifying repository files. All findings are recommendations and observations only.

The audit itself was conducted entirely through file reads and text search. No application code, schema, migration, seed data, configuration, dependency or test was created or altered; no migration was applied; no database was connected to; no server or build was started; no verification script was executed.

The sole file written was **this report** (`SCENARIO_AUDIT_1A_REGISTRATION_TO_CONSULTATION.md`), created at the user's explicit instruction that the audit be documented in a markdown file. It is a new document and modifies nothing that existed beforehand.
