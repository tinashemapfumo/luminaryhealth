-- =============================================================================
-- 011 · Messaging delivery
-- =============================================================================
--
-- Outbound messages go to an n8n webhook, which owns the actual carrier
-- integration. That indirection is deliberate: SMS providers in this market
-- change, differ per practice, and are the sort of thing a clinic's own IT
-- person may want to rewire without a deployment.
--
-- Messages are queued in the database first and dispatched afterwards. During
-- an outage the queue simply grows — the same property that makes the local
-- server useful — and nothing is lost because sending is never the thing that
-- records the intent.

SET search_path = luminary, public;

ALTER TABLE luminary.practice_settings
  ADD COLUMN IF NOT EXISTS messaging_webhook_url text,
  -- Verifies that a delivery receipt really came from our own n8n workflow.
  ADD COLUMN IF NOT EXISTS messaging_webhook_secret text;

ALTER TABLE luminary.message
  ADD COLUMN IF NOT EXISTS recipient text,
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS provider_ref text,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- 'queued' is the resting state during an outage, so it needs to be cheap to find.
CREATE INDEX IF NOT EXISTS message_queue_idx
  ON luminary.message (practice_id, queued_at)
  WHERE status = 'queued' AND deleted_at IS NULL;

ALTER TABLE luminary.message
  DROP CONSTRAINT IF EXISTS message_status_known;
ALTER TABLE luminary.message
  ADD CONSTRAINT message_status_known
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'cancelled'));
