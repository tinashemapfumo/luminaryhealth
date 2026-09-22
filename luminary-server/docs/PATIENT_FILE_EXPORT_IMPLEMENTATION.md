# Patient File Export Implementation

Date: 2026-09-22

## Direction

The staff-only patient export MVP is implemented. Deployment should wait for the dependency advisory finding below to be triaged, then proceed through the normal database backup and migration process. It is intentionally an internal controlled export capability, not a patient portal or external-provider delivery workflow.

## Delivered capability

Authorized staff can open a patient chart, select **Export file**, record a purpose, choose a date range and permitted sections, and request an asynchronous export. The browser polls the durable job and downloads the resulting one-time ZIP when ready.

Available sections:

- patient summary;
- signed/amended clinical encounters, addenda, prescriptions, laboratory results, and non-draft referrals;
- appointment history;
- billing invoices;
- original active patient documents.

The archive contains readable PDFs plus `manifest.json`. The manifest records the export scope and SHA-256 checksum for every included file. Draft encounters and draft referrals are excluded.

## API

- `POST /patients/:id/exports`
- `GET /patients/:id/exports`
- `GET /patient-exports/:id`
- `GET /patient-exports/:id/download`
- `POST /patient-exports/:id/revoke`

## Security and privacy controls

- Dedicated `exportPatientRecord` permission synchronized across backend and frontend.
- Doctors and managers receive the permission; clinical sections additionally require `viewClinicalNotes`.
- Billing additionally requires `readClaims`.
- The existing care-relationship/break-glass rule is required before any export operation.
- Practice identity comes from the authenticated session and PostgreSQL forced RLS.
- Export request, download, and revocation are audited without copying clinical payloads into audit details.
- Download responses disable browser/proxy caching.
- Downloads are single-use and expire after 24 hours.
- Worker claiming uses `FOR UPDATE SKIP LOCKED` to prevent two workers generating one job.
- Export ZIP files use private filesystem permissions and are removed after expiry; revoked and failed artifacts are cleanup candidates.
- Export jobs are deliberately not synchronized between nodes because artifact bytes are node-local.

## Database and worker

Migrations:

- `043_patient_file_exports.sql`
- `044_patient_export_cleanup.sql`
- `045_remove_obsolete_export_cleanup_function.sql`

The `patient_export_job` lifecycle is:

`pending -> processing -> ready -> expired`

Terminal alternatives are `failed` and `revoked`. A background worker claims one pending job per pass, generates the package by streaming it to private storage, and removes expired/revoked/failed artifacts.

## Verification

- Complete clean PostgreSQL rebuild through migration 044 passed; migration 045 removes only the superseded cleanup helper and was then applied cleanly.
- Immediate second migration run: `Already up to date`.
- Patient export integration suite: 12 passed, 0 failed.
- WhatsApp PostgreSQL regression suite: 29 passed, 0 failed.
- Agent tests: 8 passed, 0 failed, 0 skipped.
- Executive Insight tests: 9 passed, 0 failed, 0 skipped.
- Backend typecheck, build, lint, integration contract, and 190-cell permission contract passed.
- Frontend lint and eight-user render/tenant verification passed.
- Vite transformed 1,358 modules and emitted current referenced production assets.

The export integration suite proves care-relationship refusal, manager clinical-content refusal, asynchronous request and atomic claim, ZIP generation, RLS isolation, expected archive entries, single-use download, physical expiry cleanup, revocation, and database rejection of unknown sections.

## Deferred hardening

- ZIP password encryption and independent password delivery are not implemented. Files rely on private at-rest storage, authenticated one-time download, and short retention.
- FHIR or other interoperable structured export is not implemented.
- Original-document archive generation is implemented but the current integration fixture validates generated PDFs rather than a mixed large-document bundle.
- There is no recipient delivery workflow; staff remain responsible for transferring the downloaded archive securely.
- Sustained load, very large chart, interrupted-download, and worker-crash recovery tests remain advisable before high-volume use.
- Product/legal owners should approve the default retention period and required purpose vocabulary before broad rollout.
- npm's package-lock update reported four dependency advisories (three high and one critical). The offline audit cache reported none, while detailed online advisory retrieval was blocked to avoid disclosing the private manifest without authorization. Treat this as unresolved until an authorized audit identifies whether the findings affect production dependencies and provides non-breaking remediation.

## Deployment recommendation

Hold deployment until the reported npm advisories are identified and triaged. Once cleared, deploy the API, frontend, migrations 043-045, and worker together. Back up PostgreSQL and patient-document storage first. After migration, smoke-test one authorized doctor export and one denied cross-role attempt on the target environment. Do not expose the storage directory through the web server.
