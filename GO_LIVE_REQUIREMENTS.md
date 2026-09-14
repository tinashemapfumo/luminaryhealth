# Luminary Health Go-Live Requirements

This is the final checklist to return to when the build feels complete. It separates what blocks a real launch from what can remain as a controlled post-launch improvement.

## Current Status

The frontend and server build cleanly, core permission contracts pass, and live-mode API wiring has begun. The app is not ready to run as a real clinical system until the hard blockers below are closed and `verify:live` passes against an actual tenant.

## Hard Go-Live Blockers

- Server `.env` created for the target environment.
- `DATABASE_URL` points to a real PostgreSQL database using the non-superuser app role.
- All migrations applied successfully, including `019_patient_documents.sql`.
- API is running and `/health` returns `status: ok`.
- Frontend built with production `VITE_API_URL`.
- `WEB_ORIGINS` allows only the deployed frontend origin.
- Real practice, user, and role data provisioned.
- `npm run verify:live` passes with `LUMINARY_API`, `LUMINARY_PRACTICE`, `LUMINARY_EMAIL`, and `LUMINARY_PASSWORD`.
- Row-level security verified with the app DB role, not a superuser.
- TLS/domain/reverse proxy configured.
- Backup and restore process tested for both PostgreSQL and client-file storage.

## Clinical Workflow Requirements

- Patient registration requires consent to treat.
- Patient chart access enforces care relationship or break-glass.
- Break-glass access requires a reason and writes alert-level audit.
- Clinical notes support draft, save, sign, and addendum.
- Signed notes are immutable at database level.
- Signing requires complete SOAP fields and at least one diagnosis.
- Lapsed clinician registration blocks signing and prescribing.
- Vitals can be recorded by permitted clinical roles.
- Prescribing blocks obvious allergy conflicts.
- Clinical document upload/download works for PDF, image, and DICOM files.
- Uploaded clinical files are never stored as DB blobs.
- Document metadata is tenant-scoped and audited.
- Lab/radiology result ingestion and review workflow is defined.
- Referral workflow is defined.
- Care plan lifecycle is live-backed or explicitly deferred.

## File Storage Requirements

- `CLIENT_FILE_STORAGE_PATH` configured outside the application source tree.
- Storage location is encrypted or hosted on encrypted disk/object storage.
- Storage location is included in automated backups.
- Restore drill confirms DB metadata and file bytes line up.
- Storage path is shared across API nodes, or deployment is single-node by design.
- Malware scanning is added before production file acceptance.
- Maximum upload size and accepted file types are documented for users.
- Incorrect upload archive/delete flow exists, or a manual operational procedure is documented.
- Downloads require authenticated API access; no public file URLs.
- Operational monitoring alerts on failed writes, missing files, and low disk space.

## Financial And Claims Requirements

- Invoice creation verified with real tariff/scheme data.
- Payments verified for same-currency and foreign-currency tenders.
- Reversals verified as counter-entries, never deletions.
- Write-off and credit-note permissions verified.
- Patient statements allocate payments oldest debt first.
- Aging report reconciles to open receivables.
- Claims expose required diagnosis/coding data from signed encounters.
- Biometric capture workflow verified.
- NH263 switch submission/adjudication integration connected or a manual production procedure approved.
- Claim rejection moves patient responsibility correctly.

## Communications And Integrations

- SMS/WhatsApp/email provider credentials configured.
- Consent rules verified before sending non-exempt messages.
- Message delivery receipts ingested.
- Inbound message matching verified against phone-number normalization.
- Integration credentials are scoped and rotated safely.
- n8n/agent workflows are deployed only with signed request verification.
- Lab/radiology integrations are either connected or explicitly manual at launch.
- Payment provider integration is either connected or explicitly manual at launch.

## Security And Compliance

- Production secrets are stored outside source control.
- Password/session policy reviewed.
- Session revocation verified.
- CORS allowlist reviewed.
- Audit log review procedure assigned to a real owner.
- Admin role cannot view clinical records by default.
- Role assignment separation of duty verified.
- No PHI appears in client-side logs, server logs, or build artifacts.
- Dependency vulnerability review completed.
- Disaster recovery contact and escalation plan documented.

## E2E Verification Matrix

- Admin: manage users/settings/integrations without patient chart access.
- Doctor: own-patient workflow, break-glass workflow, note signing, prescriptions, orders.
- Nurse: registration support, vitals, check-in, document upload, no prescribing.
- Receptionist: registration, appointments, check-in, billing, no clinical notes.
- Manager: billing, claims, reporting, audit, tariffs, no clinical note reading unless explicitly granted.
- Tenant boundary: no user can see another practice's patients, appointments, documents, notes, invoices, claims, messages, or audit rows.
- Offline/local node: sync status visible, conflicts visible, no silent loss of clinical writes.

## Operational Launch Requirements

- Production database provisioned.
- Production API deployed.
- Production frontend deployed.
- Domain and TLS live.
- Monitoring and alerting live.
- Error reporting live.
- Backups scheduled and tested.
- File storage backups scheduled and tested.
- Migration rollback plan documented.
- First-practice onboarding checklist created.
- Staff training completed for break-glass, note signing, payments, reversals, and document uploads.

## Known Deferrals To Decide

- **Schema readiness gate.** Startup/readiness must eventually verify the required database schema version before the API can report ready or accept normal production traffic. The check should read the normal migration ledger, detect missing or drifted required migrations, fail closed for readiness, and make the mismatch visible in deployment logs/status. This was intentionally deferred during Scenario 011 recovery to avoid changing boot/deployment behavior while stabilizing reporting.
- In-app PDF/image/DICOM preview.
- File archiving/deletion UI.
- Full radiology/lab result ingestion.
- Full referral management.
- Full prescription printing/e-prescribing.
- Full NH263 automated claim response handling.
- Multi-node binary file replication, if not using shared storage.
- Code-splitting to remove the current large frontend chunk warning.
