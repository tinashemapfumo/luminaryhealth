-- =============================================================================
-- 002 · Practices, users, sessions
-- =============================================================================
-- `practice` is the tenant root and is deliberately NOT itself tenant-scoped:
-- the cloud node holds every practice, while a local node holds exactly one.
-- Everything else hangs off it.

SET search_path = luminary, public;

CREATE TABLE luminary.practice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text        NOT NULL,
  short_name         text        NOT NULL,
  address_line       text,
  city               text,
  phone              text,
  email              citext,
  -- Zimbabwe is heavily dollarised; a clinic quotes and collects in both.
  primary_currency   text        NOT NULL DEFAULT 'ZWL',
  secondary_currency text,
  usd_rate           numeric(12,4),
  plan               text        NOT NULL DEFAULT 'starter',
  -- The local server that owns this practice's data, if it has one.
  home_node          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  origin_node        text
);

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------
-- Deactivation, never deletion: the audit trail references these rows, and a
-- record of who did what is worthless if the who can be erased.
--
-- `registration_expires` is a clinical safety control rather than a detail. A
-- practitioner whose registration has lapsed must not be able to sign a note or
-- prescribe, and the server is the only place that can be enforced.
CREATE TABLE luminary.app_user (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id           uuid        NOT NULL REFERENCES luminary.practice(id),
  email                 citext      NOT NULL,
  full_name             text        NOT NULL,
  display_name          text        NOT NULL,
  initials              text,
  job_title             text,
  role                  text        NOT NULL CHECK (role IN ('admin', 'doctor', 'nurse', 'manager', 'receptionist')),
  -- Argon2id. Never a reversible format, never set by an administrator —
  -- accounts are created by invitation and the holder chooses the secret.
  password_hash         text,
  registration_number   text,
  registration_expires  date,
  is_provider           boolean     NOT NULL DEFAULT false,
  active                boolean     NOT NULL DEFAULT true,
  on_leave_until        date,
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  origin_node           text,
  UNIQUE (practice_id, email)
);

CREATE INDEX app_user_practice_idx ON luminary.app_user (practice_id) WHERE deleted_at IS NULL;

-- Invitations, so a credential is never issued by an administrator.
CREATE TABLE luminary.user_invitation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  email        citext      NOT NULL,
  role         text        NOT NULL,
  invited_by   uuid        NOT NULL REFERENCES luminary.app_user(id),
  token_hash   text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

-- Sessions are server-side so they can be revoked. A stateless JWT cannot be
-- withdrawn, and "sign this person out everywhere" is a requirement the moment
-- a laptop goes missing from a clinic.
CREATE TABLE luminary.session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  user_id      uuid        NOT NULL REFERENCES luminary.app_user(id),
  token_hash   text        NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  origin_node  text
);

CREATE INDEX session_live_idx ON luminary.session (user_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- Practice configuration
-- -----------------------------------------------------------------------------
-- Providers, rooms, hours, schemes, and tariffs were constants in the frontend
-- until they became configuration. They are tables because they differ per
-- practice and change without a deployment.

CREATE TABLE luminary.room (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid        NOT NULL REFERENCES luminary.practice(id),
  name        text        NOT NULL,
  kind        text        NOT NULL DEFAULT 'Consulting',
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text
);

CREATE TABLE luminary.scheme (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id       uuid          NOT NULL REFERENCES luminary.practice(id),
  name              text          NOT NULL,
  -- Reimbursement varies by scheme. The frontend hardcoded 80%, which was
  -- computing real money from a guess.
  reimburse_percent numeric(5,2)  NOT NULL DEFAULT 0,
  requires_preauth  boolean       NOT NULL DEFAULT false,
  active            boolean       NOT NULL DEFAULT true,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  origin_node       text
);

CREATE TABLE luminary.service_tariff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid           NOT NULL REFERENCES luminary.practice(id),
  code        text           NOT NULL,
  description text           NOT NULL,
  price       numeric(12,2)  NOT NULL,
  currency    text           NOT NULL DEFAULT 'ZWL',
  active      boolean        NOT NULL DEFAULT true,
  created_at  timestamptz    NOT NULL DEFAULT now(),
  updated_at  timestamptz    NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text,
  UNIQUE (practice_id, code)
);

-- Single-row-per-practice settings that do not warrant their own tables.
CREATE TABLE luminary.practice_settings (
  practice_id            uuid PRIMARY KEY REFERENCES luminary.practice(id),
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  opens_at               time        NOT NULL DEFAULT '08:00',
  closes_at              time        NOT NULL DEFAULT '17:00',
  slot_minutes           int         NOT NULL DEFAULT 15,
  open_days              text[]      NOT NULL DEFAULT ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'],
  idle_timeout_minutes   int         NOT NULL DEFAULT 15,
  minimum_password_length int        NOT NULL DEFAULT 12,
  break_glass_enabled    boolean     NOT NULL DEFAULT true,
  enforce_registration   boolean     NOT NULL DEFAULT true,
  -- Identifiers only. Secrets live in the secret store and are write-only from
  -- the API; they are never returned to a browser.
  nh263_provider_number  text,
  nh263_endpoint         text,
  sms_sender_id          text,
  sms_gateway            text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  origin_node            text
);

SELECT luminary.make_tenant_table('luminary.app_user');
SELECT luminary.make_tenant_table('luminary.user_invitation');
SELECT luminary.make_tenant_table('luminary.session');
SELECT luminary.make_tenant_table('luminary.room');
SELECT luminary.make_tenant_table('luminary.scheme');
SELECT luminary.make_tenant_table('luminary.service_tariff');
SELECT luminary.make_tenant_table('luminary.practice_settings');
