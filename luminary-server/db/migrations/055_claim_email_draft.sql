-- Persist the editable email claim pack separately from the immutable snapshot
-- created when a claim is eventually submitted.
ALTER TABLE luminary.claim
  ADD COLUMN IF NOT EXISTS email_draft jsonb NOT NULL DEFAULT '{}'::jsonb;

