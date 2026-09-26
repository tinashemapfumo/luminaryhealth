-- Structured, payer-neutral preparation data. Channel adapters can later map
-- these fields into their own payloads without changing the canonical claim.
SET search_path = luminary, public;

ALTER TABLE luminary.claim
  ADD COLUMN IF NOT EXISTS supporting_info jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE luminary.claim_attachment
  DROP CONSTRAINT IF EXISTS claim_attachment_attachment_type_check;

ALTER TABLE luminary.claim_attachment
  ADD CONSTRAINT claim_attachment_attachment_type_check CHECK (attachment_type IN (
    'preauthorization','prescription','laboratory_request','laboratory_result',
    'radiology_request','radiology_report','pathology_report','referral',
    'clinical_motivation','operation_note','anaesthetic_record','implant_device',
    'hospital_breakdown','discharge_document','accident_report','consent',
    'proof_of_payment','clinical_support','other'
  ));
