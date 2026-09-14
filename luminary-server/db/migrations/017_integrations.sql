-- =============================================================================
-- 017 · Machine integrations: inbound messaging and delivery receipts
-- =============================================================================
--
-- Outbound already works: `messaging.dispatcher` posts queued messages to a
-- configured n8n webhook, signed with the practice's secret. What has never
-- existed is the return path — a patient replying on WhatsApp, and the carrier
-- saying whether a message arrived. `verifySignature` has been sitting in
-- `messaging.service.ts` since messaging was written, called by nothing,
-- because there was no inbound route to call it.
--
-- Two things make this different from every other endpoint in the system:
--
-- **The caller is a machine, not a person.** n8n has no session, no role and no
-- care relationship. It gets a credential of its own with a narrow scope, so a
-- leaked workflow key cannot read charts — it can post messages and nothing
-- else.
--
-- **The caller can retry.** Carriers and workflow engines redeliver on timeout,
-- so every write here is idempotent on the provider's own identifier. Without
-- that, one slow response turns into a duplicate conversation.

SET search_path = luminary, public;

-- -----------------------------------------------------------------------------
-- Integration credentials
-- -----------------------------------------------------------------------------
CREATE TABLE luminary.integration_credential (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  name         text        NOT NULL,
  -- Sent in the clear so the server can find the row before it can verify
  -- anything. It identifies; it does not authenticate.
  key_id       text        NOT NULL UNIQUE,
  -- The shared secret, hashed. A stolen backup must not yield a working key,
  -- which is the same reason a password is never stored either.
  secret_hash  text        NOT NULL,
  -- What this credential may do. Deliberately not a role: n8n is not a kind of
  -- staff member, and giving it one would mean every future permission granted
  -- to that role silently extends to a webhook.
  scopes       text[]      NOT NULL DEFAULT '{}',
  active       boolean     NOT NULL DEFAULT true,
  last_used_at timestamptz,
  expires_at   timestamptz,
  created_by   uuid REFERENCES luminary.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

COMMENT ON COLUMN luminary.integration_credential.scopes IS
  'messaging:inbound, messaging:status, messaging:send. Checked per route.';

-- -----------------------------------------------------------------------------
-- Inbound messages
-- -----------------------------------------------------------------------------
--
-- A patient replying is not the same object as a message the practice sent, and
-- collapsing the two would make "who said this?" a matter of reading a column
-- correctly. Kept apart so an inbound row can never be mistaken for something
-- the practice authored.
CREATE TABLE luminary.inbound_message (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  -- Null when the number matches no patient. Deliberately nullable: attaching
  -- an unknown number to a plausible-looking patient would put one person's
  -- medical conversation in another's record.
  patient_id   uuid REFERENCES luminary.patient(id),
  channel      text        NOT NULL DEFAULT 'whatsapp'
                           CHECK (channel IN ('whatsapp', 'sms', 'email')),
  from_number  text        NOT NULL,
  body         text        NOT NULL,
  media_url    text,
  -- The carrier's own id for this message. The idempotency key: a redelivery
  -- carries the same one and must not create a second conversation.
  provider_ref text        NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when a person has dealt with it, so a reply cannot sit unread for ever
  -- simply because nobody owned it.
  handled_at   timestamptz,
  handled_by   uuid REFERENCES luminary.app_user(id),
  raw          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text,
  UNIQUE (practice_id, provider_ref)
);

CREATE INDEX inbound_message_unhandled_idx
  ON luminary.inbound_message (practice_id, received_at)
  WHERE handled_at IS NULL AND deleted_at IS NULL;

CREATE INDEX inbound_message_patient_idx
  ON luminary.inbound_message (patient_id, received_at)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- Delivery receipts
-- -----------------------------------------------------------------------------
--
-- Kept as its own append-only trail rather than only stamping the message,
-- because a carrier reports a sequence — sent, delivered, read, or failed — and
-- the sequence is the useful part when a practice asks why a reminder did not
-- reach someone.
CREATE TABLE luminary.message_receipt (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  message_id   uuid        NOT NULL REFERENCES luminary.message(id),
  status       text        NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  detail       text,
  provider_ref text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text,
  -- One receipt per status per message. A carrier that redelivers "delivered"
  -- three times leaves one row, not three.
  UNIQUE (practice_id, message_id, status)
);

-- 'read' is a WhatsApp state the older constraint did not know about.
ALTER TABLE luminary.message
  DROP CONSTRAINT IF EXISTS message_status_known;
ALTER TABLE luminary.message
  ADD CONSTRAINT message_status_known
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled'));

ALTER TABLE luminary.message
  ADD COLUMN IF NOT EXISTS read_at timestamptz,
  -- Set when a message was created by an integration rather than by a user, so
  -- `sent_by` staying null is explained rather than looking like missing data.
  ADD COLUMN IF NOT EXISTS sent_via_credential uuid REFERENCES luminary.integration_credential(id);

-- A carrier reference has to be findable, because that is all a status callback
-- carries.
CREATE INDEX IF NOT EXISTS message_provider_ref_idx
  ON luminary.message (practice_id, provider_ref)
  WHERE provider_ref IS NOT NULL AND deleted_at IS NULL;

SELECT luminary.make_tenant_table('luminary.integration_credential');
SELECT luminary.make_tenant_table('luminary.inbound_message');
SELECT luminary.make_tenant_table('luminary.message_receipt');
