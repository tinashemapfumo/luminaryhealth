# WhatsApp Agent Technical Implementation Assessment
## Purpose and conclusion

This document assesses the existing Luminary Health backend for a WhatsApp
patient-engagement agent orchestrated through n8n. It covers patient intake and
post-consultation follow-up. It is an implementation blueprint, not an
implementation.

Luminary already has most of the required foundation:

- practice-scoped integration credentials;
- signed HMAC machine requests;
- explicit integration scopes;
- server-side tenant resolution and PostgreSQL row-level security;
- existing WhatsApp/n8n messaging routes;
- conversation-bound agent tools and OTP verification;
- intake proposals and patient duplicate detection;
- append-only auditing; and
- message-delivery idempotency.

The integration should extend the existing agent architecture, not introduce a
parallel API subsystem. The strongest existing design rule is that patient-facing
agent tools accept a conversationId rather than a caller-selected patientId.
Luminary resolves and binds the patient server-side. That rule should remain.

## 1. Current architecture discovered

### Application and HTTP structure

The backend is a Fastify and PostgreSQL application using Zod validation and
transaction-scoped PostgreSQL tenant context.

Relevant files:

- src/app.ts
- src/main.ts
- src/platform/http.ts
- src/platform/db.ts
- src/platform/errors.ts

src/app.ts registers the patient, scheduling, clinical, messaging, integration,
agent, and audit modules. src/platform/http.ts preserves exact raw JSON bytes for
signed requests, exempts known machine routes from browser-session resolution,
and maps Zod failures to field-level 400 responses. Each machine route still has
its own integration authentication and scope guard.

### Machine authentication

src/platform/integration.ts provides requireIntegration(scope). It:

1. Reads x-luminary-key, x-luminary-timestamp, and x-luminary-signature.
2. Checks the timestamp against a five-minute clock-skew window.
3. Resolves the credential through luminary.lookup_integration_credential.
4. Rejects missing, revoked, expired, or incorrectly signed credentials.
5. checks the required route scope.
6. Places the credential-derived practice and credential identity on
   request.integration.

Requests use HMAC-SHA256 over timestamp + "." + exactRawBody. The request body
does not determine tenancy.

Current scopes in src/platform/integration-keys.ts are:

    messaging:inbound
    messaging:status
    messaging:send
    agent:converse
    agent:schedule
    agent:intake
    agent:status
    agent:insight
    agent:report
    claims:status

Credential persistence is defined in db/migrations/017_integrations.sql. One
credential belongs to one practice and carries a text-array scope list. The
narrow pre-tenancy lookup is implemented in
db/migrations/035_scenario017_messaging_runtime.sql.

Credential administration is implemented in:

- src/modules/integrations/integrations.routes.ts
- src/modules/integrations/integrations.service.ts

Only a user with manageIntegrations can issue or revoke a credential. Signing
material is returned once and is not recoverable from the database.

### Tenant isolation

Machine handlers enter tenant context with the practice resolved from the
credential:

    withTenant({
      practiceId: request.integration.practiceId,
      userId: null
    }, work)

PostgreSQL row-level security restricts downstream reads and writes.
src/platform/tenant-refs.ts supplies reusable checks for patients, appointments,
encounters, providers, and users.

### Existing agent architecture

src/modules/agent/agent.routes.ts already exposes:

    POST /agent/conversations
    POST /agent/verify/start
    POST /agent/verify/confirm
    POST /agent/availability
    POST /agent/appointments
    POST /agent/appointments/reschedule
    POST /agent/appointments/upcoming
    POST /agent/intake
    POST /agent/status

The central security rule in src/modules/agent/agent.service.ts is that no
patient-facing agent tool accepts a patient identifier. A phone number is
matched when a conversation opens, and that patient is bound to the
agent_conversation record.

db/migrations/018_agent_conversations.sql defines:

- agent_conversation, which binds credential, channel identity, patient, and
  verification state;
- agent_action, which records tool calls and request keys; and
- intake_proposal, which stages field-level changes for staff review.

Agent conversations expire after 30 minutes. Phone possession initially gives
number_only verification. OTP confirmation gives otp_verified status. Shared
telephone numbers and unmatched numbers remain unbound rather than being
guessed.

### Patient architecture

The main patient schema is in db/migrations/003_patients_and_access.sql. It
contains:

- reference, full name, preferred name, DOB, sex, and national ID;
- phone, alternate phone, email, and address fields;
- emergency contact fields;
- scheme, membership, dependant, and cover fields;
- treatment, communication, and data-sharing consents; and
- clinical-history fields.

Medical-aid and claim fields are extended in
db/migrations/021_canonical_claims.sql and later migrations.

Patient behavior is implemented in:

- src/modules/patients/patients.routes.ts
- src/modules/patients/patients.service.ts
- src/modules/patients/patients.repository.ts

Existing duplicate protection includes:

- normalized exact national-ID lookup;
- historical identity-alias lookup;
- a practice-scoped unique index on normalized active national IDs;
- probable duplicate detection using exact normalized name, DOB, and phone;
- patient merging and canonical identity aliases.

Merging is defined in db/migrations/031_scenario014_patient_identity_merge.sql.
National-ID uniqueness is introduced in
db/migrations/022_scenario001_remediation.sql.

Human registration may acknowledge a probable duplicate and records an alert
audit event. An agent must not be permitted to use that override.

### Encounters and consultation completion

Appointments carry this operational lifecycle:

    booked
    checked_in
    in_triage
    waiting_for_provider
    in_consultation
    completed
    no_show
    cancelled

Transitions are enforced in src/modules/scheduling/scheduling.routes.ts. Only
the assigned doctor can move a visit from in_consultation to completed. Every
transition is trigger-recorded by
db/migrations/033_scenario015_appointment_status_history.sql.

Clinical encounters, defined in db/migrations/004_clinical_and_billing.sql, use:

    draft
    signed
    amended

Signed encounter content is protected against rewriting by a database trigger.
The encounter follow_up field is clinical note text, not an operational
follow-up workflow.

Clinical logic resides in:

- src/modules/clinical/clinical.routes.ts
- src/modules/clinical/clinical.service.ts

There is no domain-event bus for appointment completion or encounter signing.

### Messaging and n8n

Existing messaging consists of:

- message for outbound communications;
- inbound_message for patient-originated communications;
- message_receipt for delivery, read, and failure events; and
- an asynchronous dispatcher that posts queued messages to n8n.

Relevant files:

- src/modules/messaging/messaging.routes.ts
- src/modules/messaging/messaging.service.ts
- src/modules/messaging/messaging.dispatcher.ts
- src/modules/integrations/integrations.routes.ts
- src/modules/integrations/integrations.service.ts
- db/migrations/011_messaging.sql
- db/migrations/017_integrations.sql
- db/migrations/035_scenario017_messaging_runtime.sql
- docs/n8n-whatsapp.md

Inbound messages are idempotent on practice_id plus provider_ref. Unmatched or
ambiguous numbers remain unattached for manual triage. Delivery receipts are
deduplicated and cannot move delivery state backwards.

### Audit architecture

audit_event is defined in db/migrations/005_audit.sql. It is append-only,
tenant-scoped, and protected from update or deletion by database trigger.

It records practice, human actor when present, action, subject, detail, severity,
timestamp, IP, user agent, and origin node. agent_action separately records tool,
arguments, outcome, request key, conversation, and subject ID.

Machine-audit limitations:

- machine events normally have no human actor and appear as unknown;
- audit_event does not store the integration credential;
- correlation and request IDs are not first-class fields;
- result is not consistently represented; and
- agent_action arguments can retain more patient data than necessary.

### Tasks and escalation

There is no general clinical task, notification, alert, or work-queue model.
collection_case has assignment concepts but is a financial workflow and must not
be reused for clinical review. Audit severity and the inbound-message queue are
not complete clinical escalation mechanisms.

## 2. What can be reused

| Existing component | Files | Purpose | WhatsApp reuse |
|---|---|---|---|
| Integration credentials | platform/integration.ts, integration-keys.ts, migrations 017 and 035 | Authenticate and scope machine callers | Authenticate n8n and derive the practice |
| Tenant context and RLS | platform/db.ts and tenant policies | Fail-closed practice isolation | Scope every agent operation |
| Conversation binding | agent service and migration 018 | Bind one channel identity to one patient | Keep patient selection out of LLM parameters |
| OTP verification | agent routes and service | Stronger handset verification | Gate sensitive disclosure and identity changes |
| Patient normalization | patients.repository.ts | Normalize ID, phone, and names | Build consistent matching |
| Duplicate prevention | patient service, migrations 022 and 031 | Prevent duplicate active identities | Block blind patient creation |
| Intake proposals | agent service and intake_proposal | Staff-reviewed changes | Stage existing-patient updates |
| Zod validation | route modules and platform/http.ts | Typed field validation | Define strict machine schemas |
| Appointment history | migration 033 | Record visit progression | Establish consultation completion |
| Encounter signing | clinical module and migration 004 | Finalize clinical record | Establish follow-up eligibility |
| Messaging queue | messaging module | Reliable outbound dispatch | Send follow-ups through n8n |
| Inbound idempotency | integrations service | Deduplicate carrier retries | Handle duplicate WhatsApp delivery |
| Agent action log | agent_action | Record tool activity and keys | Audit agent operations |
| Append-only audit | migration 005 | Authoritative mutation history | Record integration-originated changes |

## 3. Missing capabilities

### Patient intake

- Unknown conversations cannot create or stage a new patient.
- Patient references must be generated server-side for machine registration.
- Explicit consent evidence needs durable representation.
- Existing intake names conflict with current columns: address_line versus
  address_street, city versus address_city, and scheme_member_no versus
  member_number.

### Patient matching

- No reusable patient-match service exists.
- Phone-only conversation matching is insufficient for registration.
- Probable matching currently requires exact normalized name, DOB, and phone.
- Passport is not modeled separately from national_id.
- Matching has no formal confidence or resolution result.

### Agent authentication and scopes

The existing mechanism is sufficient. Add agent:followup. Preserve agent:intake.
Keep agent:status temporarily for the existing narrow status endpoint.

### Follow-ups

No operational follow-up entity exists. encounter.follow_up and
care_plan.next_review do not record dispatch, responses, escalation, retries, or
completion.

### Conversation storage

agent_conversation already exists. Messages are not linked to it.

### Escalation

No suitable clinical work queue exists. The follow-up should initially carry its
own review state, assignee, severity, and timestamps.

### Auditability

Credential identity, correlation ID, idempotency key, result, and affected
resource need stronger representation.

### Idempotency

- Inbound WhatsApp delivery is protected.
- Scheduling requestKey is optional and should be required for mutations.
- Intake has no request-level idempotency.
- Outbound integration sending has no idempotency key.
- Follow-up creation and responses need database-enforced keys.

### Validation

Zod is the established convention. Service and database checks must still
validate practice ownership, entity relationships, and workflow state.

## 4. Recommended database changes

### Reuse

Reuse patient, appointment, appointment_status_history, encounter, message,
inbound_message, integration_credential, agent_conversation, agent_action,
intake_proposal, and audit_event.

### Extend

Extend agent_conversation initially with:

- type;
- status;
- encounter_id;
- followup_id; and
- last_message_at.

Extend message and inbound_message with conversation_id.

Extend agent_action with credential_id, correlation_id, and bounded response
metadata.

Extend audit_event with nullable integration_credential_id, correlation_id,
request_id, and result fields. Do not store raw request bodies.

### New patient_followup table

Recommended columns:

    id
    practice_id
    patient_id
    encounter_id
    appointment_id
    conversation_id
    status
    scheduled_for
    sent_at
    responded_at
    summary
    structured_response jsonb
    symptom_status
    medication_adherence
    requires_clinical_review
    escalation_level
    review_reason
    assigned_to
    reviewed_by
    reviewed_at
    completed_at
    idempotency_key
    created_at
    updated_at
    deleted_at
    origin_node

Required invariants:

- all references belong to the same practice;
- encounter belongs to patient;
- appointment, when present, belongs to patient;
- initially, one active follow-up exists per encounter;
- practice_id plus idempotency_key is unique when present;
- escalated records require requires_clinical_review;
- completed records require completed_at.

Do not reuse care_plan. Do not add a second conversation table. Do not add a
ConversationMessage table initially.

Relationship outline:

    practice
      +-- integration_credential
      |     +-- agent_conversation
      |           +-- patient
      |           +-- patient_followup
      |           +-- inbound_message
      |           +-- message
      +-- patient
            +-- appointment
            +-- encounter
            +-- patient_followup

## 5. Recommended API surface

Preserve the existing /agent convention.

### POST /agent/conversations

Required scope: agent:converse

Purpose: Open or reuse a short-lived server-bound conversation.

Request: Channel and sender address.

Response: Conversation ID, match state, verification state, expiry, and handover
instruction.

Validation: Existing Zod schema and normalized channel identity.

Reuse: agentService.openConversation.

Errors: 400, 401, 403.

### POST /agent/intake/match

Required scope: agent:intake

Purpose: Evaluate identity evidence and bind the conversation when exactly one
safe match exists.

Request fields: conversationId, firstName, lastName, dateOfBirth, phone, and
optional nationalId.

Response result:

    matched
    no_match
    ambiguous
    insufficient_evidence

The response should state knownPatient and verificationRequired but should not
return candidate lists, unmasked identifiers, or unrelated patient IDs.

Validation: Strict Zod schema, normalization, and domain matching policy.

Reuse: Patient normalization, duplicate lookup, identity aliases, and
conversation binding.

Errors: 400, 401, 403, 409.

### POST /agent/intake/patients

Required scope: agent:intake

Purpose: Create a patient after a confirmed no_match result.

Request: Conversation ID, required idempotency key, required demographics, and
explicit consent evidence.

Response: New patient resource ID, reference, and status only.

The service must:

- repeat matching inside the creation transaction;
- refuse ambiguous matches;
- generate the patient reference server-side;
- never accept duplicateAcknowledged from the agent; and
- bind the created patient to the conversation.

Errors: 400, 401, 403, 409, 422.

### POST /agent/intake/proposals

Required scope: agent:intake

Purpose: Stage allowlisted changes for an existing conversation-bound patient.

Initial allowlist:

    phone
    altPhone
    email
    addressStreet
    addressSuburb
    addressCity
    preferredContact
    emergencyName
    emergencyRelation
    emergencyPhone

Medical-aid changes should use a separately reviewed category. Name, DOB, sex,
and national ID should not be silently changed by the agent.

Keep /agent/intake as a compatibility route until n8n migrates.

### POST /agent/followups

Required scope: agent:followup

Purpose: Idempotently create or retrieve an eligible follow-up requirement.

Require an Idempotency-Key. Validate completed appointment, signed encounter,
same-patient relationships, and uniqueness. Server-originated creation is
preferred; this endpoint supports controlled retries and explicit scheduling.

Errors: 400, 401, 403, 404, 409.

### GET /agent/followups/:id

Required scope: agent:followup

Purpose: Read only operational state needed to continue the follow-up.

Return workflow state, permitted question set, timing, and escalation state.
Never return the full clinical note. Require both tenant ownership and
conversation association.

### POST /agent/followups/:id/responses

Required scope: agent:followup

Request fields:

- conversationId;
- responseKey;
- bounded summary;
- structured patientResponse;
- symptomStatus;
- medicationAdherence; and
- requiresClinicalReview.

Validate the follow-up, conversation, patient, encounter, and practice
relationships. Deduplicate responseKey.

### POST /agent/followups/:id/escalations

Required scope: agent:followup

Request fields:

- conversationId;
- requestKey;
- bounded escalation level;
- bounded reason code; and
- summary.

The backend independently validates levels and reason codes. The LLM cannot
select the practice or an arbitrary staff member.

### POST /agent/followups/:id/complete

Required scope: agent:followup

Purpose: Complete a non-escalated follow-up. Escalated records require staff
review and cannot be completed by n8n.

## 6. Authentication and tenancy flow

    n8n
      |
      | signed Luminary headers
      v
    platform/http.ts preserves exact raw body
      |
      v
    requireIntegration(requiredScope)
      |
      | credential lookup
      | active, expiry, timestamp, HMAC checks
      | scope check
      v
    request.integration.practiceId
      |
      v
    withTenant({ practiceId, userId: null })
      |
      | PostgreSQL current_practice_id()
      | forced row-level security
      v
    agent handler and domain service

Existing implementation points:

- raw body handling: registerHttp in src/platform/http.ts;
- guard: requireIntegration in src/platform/integration.ts;
- signing rules: src/platform/integration-keys.ts;
- lookup: luminary.lookup_integration_credential in migration 035;
- tenant transaction: withTenant in src/platform/db.ts;
- resource checks: src/platform/tenant-refs.ts.

The agent must never send practiceId. Strict machine schemas should reject
tenancy fields rather than silently discard them.

## 7. Follow-up lifecycle

Recommended lifecycle:

    pending
      -> scheduled
      -> queued
      -> sent
      -> awaiting_response
      -> responded
      -> escalated
      -> under_review
      -> completed

Terminal alternatives:

    cancelled
    failed
    expired

Rules:

- Eligibility requires a completed appointment and a signed or amended
  encounter.
- Creation is idempotent on encounter.
- Sent state is synchronized from the outbound message.
- A response moves awaiting_response to responded once.
- Later patient messages remain in message history and do not overwrite the
  original structured response.
- Escalation ends autonomous completion.
- Escalated records leave review state only through a staff action.

Signing and appointment completion can occur in either order. Both service paths
should call an idempotent ensureFollowupForEncounter function.

There is no event bus. Do not introduce one only for this feature. Use the
transactional ensure function plus a periodic reconciliation worker, consistent
with the existing polling architecture.

## 8. Conversation architecture recommendation

Do not create a second Conversation model. agent_conversation already owns the
security-critical identity binding, credential association, verification, and
expiry behavior.

Do not create ConversationMessage initially. Add conversation_id to message and
inbound_message:

    agent_conversation
      +-- message
      +-- inbound_message

A staff timeline can query both tables and normalize direction and timestamps.
Only introduce a separate message model if future requirements include editing,
reactions, multi-part attachments, internal notes, or cross-channel threading.

## 9. Security risks

| Risk | Mitigation |
|---|---|
| Cross-practice access | Credential-derived practice, forced RLS, same-practice constraints, and 404 for invisible resources |
| Mass assignment | Strict Zod schemas and fixed field maps |
| Prompt injection | Conversation-bound patient identity; no routine patientId input |
| Hallucinated identifiers | Resolve all relationships server-side |
| Duplicate patient creation | Exact match, aliases, probable match, transaction recheck, and unique constraints |
| Shared phones | Return ambiguous and require handover |
| Patient-data exposure | Return match outcomes, not patient candidates or chart content |
| Unsafe identity updates | OTP and staff review |
| Unsafe clinical responses | Agent collects, clarifies, structures, classifies, and escalates only |
| Forged urgency classification | Bounded codes plus deterministic backend safety rules |
| Duplicate requests | Required idempotency keys and unique constraints |
| Replay attacks | Timestamped HMAC plus operation idempotency |
| Audit gaps | Credential and correlation context in immutable audit |
| Compromised credential | Narrow scopes, expiry, revocation, one practice per credential |
| Sensitive logs | Never log raw bodies, OTPs, national IDs, full messages, or clinical payloads |
| Arbitrary resource access | Require conversation association as well as UUID existence |
| Unsafe completion | Escalated records require a human actor |

Prompt instructions are not a security boundary. Structured LLM output remains
untrusted input.

## 10. Implementation sequence

1. Correct existing intake field/schema mismatches.
2. Make machine schemas strict and require mutation idempotency keys.
3. Improve integration audit and correlation context.
4. Extract a reusable patient-match service.
5. Add conversation-bound intake matching.
6. Add safe patient registration with server references and transaction rematch.
7. Extend intake proposals using canonical patient fields.
8. Add agent:followup and patient_followup with relationship constraints.
9. Add idempotent follow-up creation after completion and signing.
10. Add response, escalation, completion, and staff-review workflows.
11. Link inbound and outbound messages to conversations.
12. Add reconciliation and retry processing.
13. Add security, API, service, and database tests.
14. Connect n8n only after the full test boundary passes.

## 11. Files likely to change

| File | Existing/New | Purpose | Risk |
|---|---|---|---|
| src/platform/integration-keys.ts | Existing | Add agent:followup | Low |
| src/platform/integration.ts | Existing | Propagate machine audit context | Medium |
| src/platform/db.ts | Existing | Optional credential/request DB context | High |
| src/platform/http.ts | Existing | Register new machine routes | Medium |
| src/platform/tenant-refs.ts | Existing | Follow-up relationship checks | Medium |
| src/modules/agent/agent.routes.ts | Existing | Intake and follow-up endpoints | High |
| src/modules/agent/agent.service.ts | Existing | Conversation and intake extension | High |
| src/modules/patients/patients.service.ts | Existing | Machine-safe creation path | High |
| src/modules/patients/patients.repository.ts | Existing | Bounded matching queries | High |
| src/modules/clinical/clinical.service.ts | Existing | Ensure follow-up after signing | High |
| src/modules/scheduling/scheduling.routes.ts | Existing | Ensure follow-up after completion | High |
| src/modules/messaging/messaging.service.ts | Existing | Conversation linkage and idempotency | Medium |
| src/modules/integrations/integrations.service.ts | Existing | Link inbound messages to conversations | Medium |
| db/migrations/042_agent_followups.sql | New | Follow-up schema and constraints | High |
| db/migrations/043_agent_audit_context.sql | New | Machine audit metadata | High |
| docs/n8n-whatsapp.md | Existing | Update integration contract | Low |
| scripts/verify-integration.ts | Existing | Expand security contracts | Medium |
| Agent and follow-up test files | New | Verify service and HTTP behavior | Medium |

Migration numbers assume 041 remains the latest migration when implementation
starts. Recalculate them if another migration lands first.

## 12. Test plan

### Authentication and tenancy

- Valid signed credential.
- Missing and invalid signatures.
- Expired and revoked credentials.
- Missing and incorrect scopes.
- Payload containing practiceId is rejected.
- Cross-practice patient, encounter, conversation, and follow-up access.
- Foreign UUIDs do not reveal resource existence.

### Patient intake and matching

- Valid patient creation.
- Exact normalized national-ID match.
- Historical identity-alias match.
- Exact phone, name, and DOB match.
- Shared phone returns ambiguous.
- Weak evidence remains insufficient.
- No-match registration.
- Match is repeated inside registration.
- Concurrent duplicate registration.
- Agent cannot acknowledge probable duplicates.
- Existing patient update creates proposals.
- Forbidden field update.
- Identity fields require stronger review.
- Malformed and unknown fields.
- Patient belonging to another practice.

### Follow-ups

- Completed appointment plus signed encounter creates one follow-up.
- Signing before completion.
- Completion before signing.
- Repeated ensure calls are idempotent.
- Encounter belongs to wrong patient.
- Appointment belongs to wrong patient.
- Follow-up response.
- Duplicate response.
- Follow-up escalation.
- Agent cannot complete an escalated follow-up.
- Authorized staff review and completion.
- Missing patient or encounter.
- Patient or encounter belonging to another practice.

### Messaging and reliability

- Duplicate Meta webhook delivery.
- Repeated n8n request.
- Out-of-order delivery receipt.
- Network failure and retry.
- Transaction rollback on partial failure.
- Reconciliation finds missed eligible follow-ups.
- Duplicate outbound enqueue does not send twice.
- Sensitive content is absent from application logs.

### Audit

- Every mutation records practice and credential.
- Correlation ID follows the workflow.
- Resource and result are recorded without unnecessary PHI.
- Audit rows cannot be changed or deleted.
- Refused sensitive actions are recorded where appropriate.

Extend scripts/verify-integration.ts to assert that patient-facing tools do not
accept patientId, new routes use narrow scopes, machine schemas reject
practiceId, mutation keys are required, and follow-up reads do not expose
clinical notes.

## 13. Questions and architecture conflicts

1. Generic agent patient CRUD conflicts with the conversation-bound security
   model. Patient IDs should remain absent from ordinary patient-facing tools.

2. The requested agent:patient-intake scope conflicts with established naming.
   Preserve agent:intake and add agent:followup.

3. Existing /agent/intake supports only matched patients and stages updates. It
   does not register new patients.

4. Existing intake field names do not match the current patient schema and must
   be corrected before reuse.

5. No clinical task model exists. Financial collection_case is not appropriate.
   Initially, patient_followup should be the staff-review work item.

6. Completed consultation is not one state. Appointment completion and encounter
   signing are independent. Follow-up eligibility should require both unless
   clinical policy explicitly decides otherwise.

7. Current phone matching uses normalized trailing digits. This is practical for
   Zimbabwe but should become country-aware before international rollout.

8. Passport is not represented separately. Decide whether national_id is a
   generic government identifier or whether typed patient identifiers require a
   dedicated table.

9. Current human registration requires consentTreatment to be true. WhatsApp
   registration must capture explicit, auditable consent rather than infer it.

10. Audit storage is immutable and strong, but machine attribution is incomplete.
    Add credential and correlation metadata before enabling new agent mutations.

## Final recommendation

The architecture is fundamentally suitable for the WhatsApp agent. Implement a
narrow extension of the existing credential, conversation, patient, messaging,
and audit layers, with one new operational patient_followup resource.

Do not introduce parallel tenancy, direct database access, generic agent CRUD,
or a second conversation system. Keep Luminary authoritative, keep patient
identity bound server-side, stage sensitive changes for review, and make every
mutation idempotent and auditable.
