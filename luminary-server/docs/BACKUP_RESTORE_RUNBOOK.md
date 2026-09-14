# Backup And Restore Runbook

Scenario 018 requires a written operational recovery baseline so tenant-hardening work is paired with a practical restore path.

## Scope

This runbook covers the Luminary PostgreSQL database and configured document storage roots. It does not replace environment-specific infrastructure backups, but it defines the minimum checks expected before production promotion.

## Backup

1. Stop deploy activity and confirm only the intended backend owns port 4000.
2. Record the current Git commit, backend version, `DATABASE_URL` target, and latest row in `public.schema_migration`.
3. Create a PostgreSQL logical backup with `pg_dump` using the deployment database account or an operator account with full database read privileges.
4. Back up document storage roots configured by `LOCAL_FILE_STORAGE_ROOT` or the production object-store bucket/prefix.
5. Store database and document backups together with a timestamp and environment label.
6. Verify the backup artifact size is non-zero and the command exited successfully.

## Restore Drill

1. Restore into a disposable database, never directly over live production.
2. Restore document files into a disposable storage root or bucket prefix.
3. Start the backend against the disposable target.
4. Confirm startup schema readiness succeeds and `/health` returns healthy.
5. Authenticate as an authorized manager.
6. Run tenant-integrity verification, including `npm run verify:scenario018` where seeded test actors are present.
7. Spot-check at least one patient, appointment, encounter, invoice/payment, message, and document reference.
8. Confirm document downloads return the expected bytes, not only metadata.

## Frequency

Run a restore drill before first live production launch, after migration batches that alter clinical/billing/document tables, and on a recurring production operations cadence.

## Deferred Hardening

Automated scheduled backups, retention policy enforcement, encrypted offsite replication, point-in-time recovery objectives, and full disaster-recovery automation remain production operations requirements. They are not implemented by Scenario 018 unless supplied by the hosting platform.
