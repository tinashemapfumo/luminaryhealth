-- =============================================================================
-- 019 - Patient documents stored outside the database
-- =============================================================================

SET search_path = luminary, public;

-- The file bytes live in client-file storage. The database stores only the
-- clinical index: who owns it, what it is, where it can be retrieved, and who
-- put it there.
CREATE TABLE luminary.patient_document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id   uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id    uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id  uuid REFERENCES luminary.encounter(id),
  uploaded_by   uuid        NOT NULL REFERENCES luminary.app_user(id),
  kind          text        NOT NULL DEFAULT 'document',
  filename      text        NOT NULL,
  content_type  text        NOT NULL,
  byte_size     bigint      NOT NULL CHECK (byte_size > 0),
  storage_key   text        NOT NULL,
  checksum      text        NOT NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  origin_node   text,

  CONSTRAINT patient_document_storage_key_unique UNIQUE (practice_id, storage_key)
);

CREATE INDEX patient_document_patient_idx
  ON luminary.patient_document (practice_id, patient_id, created_at DESC)
  WHERE deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.patient_document');
