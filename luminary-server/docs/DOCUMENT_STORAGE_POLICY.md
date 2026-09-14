# Luminary Health Document Storage Policy

## Current Architecture

Luminary stores clinical document metadata in PostgreSQL and stores uploaded
clinical file bytes outside PostgreSQL in the configured document-storage
backend.

The current backend is the local filesystem, rooted at
`CLIENT_FILE_STORAGE_PATH` and defaulting to `./client-files`.

Current storage keys are server-generated and practice/patient scoped:

```text
<practice_id>/<patient_id>/<date>-<uuid>-<sanitized_filename>
```

The database table `luminary.patient_document` is authoritative for document
identity and clinical ownership:

- document ID
- practice ID
- patient ID
- encounter ID, when applicable
- original filename
- MIME/content type
- byte size
- SHA-256 checksum
- uploader
- timestamps
- lifecycle state through `deleted_at`
- storage reference through `storage_key`

PostgreSQL is not the primary storage location for uploaded clinical file
bytes. Large clinical files must not be persisted as database BLOBs or base64
columns unless the architecture is deliberately changed in a future design.

## File Storage Responsibility

The storage backend is authoritative for the bytes. The database is
authoritative for what those bytes mean clinically and who owns them.

Clinical ownership is independent of physical file location. Moving a document
from local disk to a future secondary disk, NAS, or object store must preserve:

- `document_id`
- `practice_id`
- `patient_id`
- `encounter_id`
- checksum
- uploader attribution
- audit history
- clinical history

Only storage-location/reference data should need to change.

## Private Access

Clinical files are private. Luminary does not expose `client-files` as a public
static directory. File bytes are served through authenticated document routes
after normal role, tenant, and row-level security checks.

Future storage providers must preserve equivalent privacy. Object storage, if
introduced later, must not make patient files publicly readable merely because
the storage backend changed.

## Upload Integrity

Uploads are validated, decoded, stored in the configured backend, and then
indexed in `luminary.patient_document`.

The SHA-256 checksum records byte integrity. It is used to verify:

- upload integrity
- retrieval integrity
- backup/restore integrity
- storage migration integrity

Checksum does not define ownership. Ownership remains determined by database
relationships.

If a file is written successfully but the database insert fails, Luminary
performs compensating cleanup of that newly generated storage object and
rethrows the original database failure. Cleanup failure is logged and does not
turn the failed upload into a successful document.

## Active And Archived Documents

Active versus archived is a clinical/application lifecycle state. It is not the
same as hot, warm, or cold physical storage.

Archiving a document sets `patient_document.deleted_at` and records an audit
event. Active document lists and normal downloads exclude archived documents.
The physical file remains stored for traceability and future retention policy.

Luminary does not provide ordinary hard-delete of clinical documents. Physical
purge and retention rules are future administrative capabilities.

## Backup Invariant

Database backup is not a complete Luminary backup.

A complete document backup requires at minimum:

```text
PostgreSQL
+
document storage
```

Database without files means metadata points to missing clinical documents.
Files without the database are unattributed storage objects.

Future backup and disaster recovery must coordinate database and document-store
snapshots sufficiently to restore a coherent point in time. Restore testing
must prove that restored document IDs resolve to the correct bytes, with
checksums confirming integrity.

## Future Storage Direction

The current filesystem backend is acceptable for the present local deployment.
Future deployments may add storage tiers, but they are not implemented now.

Current hot storage:

- local server SSD/HDD
- active patient documents
- low-latency local access
- offline-first operation

Potential future secondary storage:

- second local drive
- NAS
- dedicated file server
- capacity, redundancy, and local resilience

Potential future offsite/object storage:

- private cloud object storage
- encrypted remote backup/archive
- disaster recovery and long-term archival

Future storage migration tooling must verify checksums before considering a
file successfully moved.

## Deferred Capabilities

The following are known deferred capabilities and are not blockers for the
current document subsystem:

- secondary HDD/NAS storage
- object/cloud storage
- storage migration tooling
- coordinated backup/restore engine
- multipart or streaming upload transport
- diagnostic order/result to document linkage
- document reviewed-state
- structured document classification
- patient merge handling for documents
- PACS/DICOM workflow, modality worklists, imaging viewer, and radiology exchange

Current DICOM MIME acceptance means Luminary can store a file exported by an
external diagnostic system. It is not a complete medical imaging architecture.
