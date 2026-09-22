# WhatsApp Patient-Engagement Validation

Date: 2026-09-22

## Database verification

Migration `042_whatsapp_patient_engagement.sql` successfully ran against a clean PostgreSQL 16 database as part of the complete 42-migration chain. The isolated database volume was deleted, recreated, and migrated from zero. A second migration run returned `Already up to date`.

The live PostgreSQL verifier ran as `luminary_validation`, a non-superuser role without `BYPASSRLS`. It passed 29 assertions covering tenant visibility, credential-bound conversations, explicit follow-up intent, lifecycle review, active-follow-up uniqueness, consent immutability, outbound compatibility/idempotency, patient matching, and concurrent duplicate registration.

Foreign keys, check constraints, partial unique indexes, forced RLS policies, and sync-related migration SQL all compiled during the clean migration. This repository uses forward-only immutable migrations and has no down-migration convention; rebuild-from-zero is the supported rollback/recovery proof used here.

## Security verification

- Practice A could not see Practice B patients, encounters, appointments, follow-ups, consent events, conversations, inbound messages, or outbound messages.
- A Practice A update targeting a Practice B patient affected zero rows under RLS.
- Two credentials in the same practice produced separate conversations. Credential A was refused access to Credential A2's conversation.
- The same sender remained distinct across WhatsApp, SMS, another credential, and another practice.
- Conversation expiry remains enforced by `requireConversation`; durable follow-up records do not depend on conversation lifetime.

## Intake verification

Verified against PostgreSQL: exact national-ID plus matching name/DOB, contradictory identity behavior in unit tests, shared-phone ambiguity, no-match behavior, incomplete-evidence refusal, tenant-scoped matching, consent attribution columns, required policy version, and append-only consent update/delete rejection.

Registration replay now stores and checks a SHA-256 request fingerprint. Reusing a key with a changed request conflicts rather than silently replaying the original registration.

Two independent PostgreSQL transactions raced the same national ID. Exactly one registration committed and one patient remained. Identity-alias registration through the complete HTTP transaction and patient-reference generation under sustained high contention remain unproven.

## Follow-up verification

- A completed appointment plus signed encounter did not create a follow-up without `follow_up_required=true`.
- Explicit intent created one follow-up; repeated ensure calls replayed the same record.
- The active-encounter partial unique index rejected a duplicate.
- Agent completion remains limited to non-escalated `responded` records.
- Escalation now excludes `completed`, `cancelled`, `failed`, and `expired` records.
- Staff review can retain `under_review` or complete while clearing the review flag.
- Reconciliation runs only with messaging dispatch enabled, every five minutes, and converges through `ensureIfEligible`.
- Reconciliation failure injection proved that a malformed practice batch is reported and does not stop later practices.

The full lifecycle transition matrix is enforced primarily by service predicates, with database checks enforcing escalation/completion consistency. A dedicated transition-matrix integration suite remains advisable before production activation.

## Escalation review

Levels: `routine`, `priority`, `urgent`.

Reason codes: `worsening_symptoms`, `new_symptoms`, `medication_problem`, `patient_requested_review`, `possible_emergency`, `uncertain_response`.

Deterministic structured-response review triggers:

- symptom status `worsening`, `new_symptoms`, or `unknown`;
- medication adherence `partial`, `not_taking`, or `unknown`;
- explicit `requiresClinicalReview=true`.

Triggered structured responses become `escalated`; their default level is `priority`. `possible_emergency` always forces `urgent`. Unknown reason codes are rejected. Contradictory answers are not autonomously interpreted and should be submitted as `uncertain_response`. Free text is stored as summary/evidence only and does not generate diagnosis, treatment advice, or autonomous clinical conclusions.

All escalation vocabulary and thresholds remain subject to clinician approval before production use.

## Outbound idempotency

PostgreSQL proved first-row uniqueness, identical retry replay, and conflict for the same key with a changed logical message. This closes the database/application duplicate-enqueue path.

Legacy `POST /integrations/messages` callers may omit `Idempotency-Key`; the response then reports `idempotencyProtected: false`. Supplied keys retain strict replay/conflict behavior. New agent mutation routes still require a key.

Real carrier timeout, worker-process restart during an active send, and duplicate n8n acknowledgement were not executable before an n8n/provider workflow exists. Those are integration acceptance tests, not evidence obtained in this backend-only pass.

## Audit validation

Agent request context carries practice, credential, correlation ID, and request/idempotency identity into audit context. Agent actions record operation, resource identity, result, and request fingerprint. Registration action arguments contain field names rather than the full registration payload. Follow-up actions retain structured status categories rather than complete clinical responses. OTPs and raw WhatsApp conversations are not written to audit/action details.

## Tests

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm run lint` | Passed, zero warnings |
| `npm run test:agent` | 8 passed, 0 failed, 0 skipped |
| `npm run test:insight` | 9 passed, 0 failed, 0 skipped |
| `npm run verify:whatsapp` | 29 PostgreSQL assertions passed |
| `npm run verify:integration` | Passed, 58 checks |
| `npm run contract:permissions` | Passed, 185 permission cells |
| `npm run verify:claims` | Passed, 31 checks |

Executable test totals: 17 Node tests and 29 PostgreSQL assertions; 0 failed and 0 skipped. Static/contract verifiers also passed as listed above.

## Issues fixed

1. Unknown symptom/adherence values could avoid review. Both now deterministically require clinical review.
2. Registration idempotency checked only operation name. It now rejects the same key with a changed request fingerprint.
3. Outbound message uniqueness prevented a duplicate row but silently accepted a changed payload. It now compares the persisted logical request and returns a conflict on mismatch.
4. Escalation allowed a failed follow-up. Failed records are now terminal for agent escalation.
5. One reconciliation tenant failure could stop later practices. Practice batches are now isolated and failures are included in structured operational output.
6. Requiring `Idempotency-Key` on the existing messaging endpoint would break legacy callers. The header is now optional there, visibly unprotected when absent, while new agent mutations remain strict.

## Remaining production blockers

1. Identity-alias registration and patient-reference generation still need sustained concurrent HTTP testing before high-volume production intake.
2. The exhaustive follow-up transition matrix needs dedicated integration coverage, although escalation, blocked agent completion, staff review, reviewed completion, terminal-state protection, and database consistency checks passed.
3. Clinician approval is required for escalation levels, reason codes, and deterministic thresholds before enabling follow-up messaging.
4. End-to-end timeout/restart/acknowledgement idempotency must be tested when the n8n/provider workflow is connected.

## Direction

The backend is suitable for commit and deployment with messaging dispatch disabled. Migration 042 and dormant API surfaces can be deployed after normal backup and smoke-test controls. Do not enable automated clinical follow-ups until clinician approval is recorded, and do not treat provider delivery semantics as certified until the n8n timeout/restart acceptance tests pass.

No n8n workflow was built during this pass.
