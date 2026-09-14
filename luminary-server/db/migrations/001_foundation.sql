-- =============================================================================
-- 001 · Foundation: roles, tenancy primitives, sync metadata
-- =============================================================================
--
-- Two decisions shape every table that follows.
--
-- 1. TENANCY IS ENFORCED BY THE DATABASE, NOT THE APPLICATION.
--    Every tenant-owned table carries `practice_id` and a row-level security
--    policy keyed on a session variable. A developer who forgets a WHERE clause
--    gets zero rows, not another clinic's patients. This is not theoretical
--    caution: the frontend leaked across tenants three separate times while the
--    access-checking functions themselves were correct. Application-layer
--    filtering is one omission away from a breach, forever, on every new query.
--
-- 2. EVERY TABLE IS SYNC-READY FROM DAY ONE.
--    A practice runs a local server that must keep working through an internet
--    outage and reconcile afterwards. That requires client-generatable ids
--    (UUID, never a sequence), a modification timestamp, the node a write came
--    from, and tombstones instead of hard deletes — a deletion has to be able to
--    replicate. Retrofitting this into live clinical data is brutal, so it is
--    here from the first migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS btree_gist; -- exclusion constraints on scheduling

-- -----------------------------------------------------------------------------
-- Application role
-- -----------------------------------------------------------------------------
-- The API connects as `luminary_app`, which owns nothing. This matters:
-- PostgreSQL exempts a table's OWNER from its own row-level security unless the
-- table is set to FORCE. Running the app as the owner would silently disable
-- every policy below. We do both — a non-owner role and FORCE — because this is
-- the single control the whole tenancy model rests on.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luminary_app') THEN
    CREATE ROLE luminary_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luminary_migrator') THEN
    CREATE ROLE luminary_migrator NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS luminary AUTHORIZATION luminary_migrator;
GRANT USAGE ON SCHEMA luminary TO luminary_app;

SET search_path = luminary, public;

-- -----------------------------------------------------------------------------
-- Tenant context
-- -----------------------------------------------------------------------------
-- The API sets these per transaction from the authenticated session — never
-- from anything the client sends. `current_practice_id()` returns NULL rather
-- than raising when unset, so an un-scoped query returns no rows instead of
-- erroring in a way someone might be tempted to catch and ignore.

CREATE OR REPLACE FUNCTION luminary.current_practice_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('luminary.practice_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION luminary.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('luminary.user_id', true), '')::uuid;
$$;

-- The node this server is: 'cloud', or a local server's identifier. Written
-- onto every row so sync can tell where a change originated and resolve
-- ordering when two nodes touched the same record.
CREATE OR REPLACE FUNCTION luminary.current_node() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('luminary.node', true), ''), 'unknown');
$$;

-- -----------------------------------------------------------------------------
-- Change log — the spine of replication
-- -----------------------------------------------------------------------------
-- Every mutation on a synced table appends here via trigger. The sync worker
-- drains this per practice and ships it to the peer. Keeping the log in the
-- database rather than the application means a write cannot be replicated
-- inconsistently with the row it describes: both happen in one transaction.

CREATE TABLE luminary.sync_change (
  seq           bigserial PRIMARY KEY,
  practice_id   uuid        NOT NULL,
  table_name    text        NOT NULL,
  row_id        uuid        NOT NULL,
  operation     text        NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  payload       jsonb       NOT NULL,
  origin_node   text        NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- Set once the change has been accepted by the peer. NULL means outstanding.
  replicated_at timestamptz
);

CREATE INDEX sync_change_pending_idx
  ON luminary.sync_change (practice_id, seq)
  WHERE replicated_at IS NULL;

-- Per-peer high-water mark, so a reconnecting node asks for the right window
-- instead of replaying everything.
CREATE TABLE luminary.sync_peer (
  practice_id   uuid        NOT NULL,
  peer_node     text        NOT NULL,
  last_sent_seq bigint      NOT NULL DEFAULT 0,
  last_recv_seq bigint      NOT NULL DEFAULT 0,
  last_contact  timestamptz,
  PRIMARY KEY (practice_id, peer_node)
);

-- Conflicts are surfaced, never silently resolved. A double-booked slot or two
-- disagreeing demographic edits become a row here for a human to settle —
-- losing a clinical write quietly is the one outcome worse than a conflict.
CREATE TABLE luminary.sync_conflict (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id   uuid        NOT NULL,
  table_name    text        NOT NULL,
  row_id        uuid        NOT NULL,
  local_payload jsonb       NOT NULL,
  peer_payload  jsonb       NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid,
  resolution    text
);

CREATE INDEX sync_conflict_open_idx
  ON luminary.sync_conflict (practice_id)
  WHERE resolved_at IS NULL;

-- -----------------------------------------------------------------------------
-- Shared column set + triggers
-- -----------------------------------------------------------------------------

-- Applied to every synced table: stamps modification metadata and appends to
-- the change log in the same transaction as the write itself.
CREATE OR REPLACE FUNCTION luminary.tg_touch_and_log() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  op text;
  rec jsonb;
  pid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Hard deletes are refused. Callers set deleted_at instead, which
    -- replicates; a row that simply vanishes cannot be told apart from a row
    -- that never arrived.
    RAISE EXCEPTION 'hard delete is not permitted on %; set deleted_at instead', TG_TABLE_NAME;
  END IF;

  NEW.updated_at := now();
  NEW.origin_node := COALESCE(NEW.origin_node, luminary.current_node());

  IF TG_OP = 'INSERT' THEN
    op := 'insert';
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    op := 'delete';           -- a tombstone, logged as the deletion it is
  ELSE
    op := 'update';
  END IF;

  rec := to_jsonb(NEW);
  pid := (rec ->> 'practice_id')::uuid;

  INSERT INTO luminary.sync_change (practice_id, table_name, row_id, operation, payload, origin_node)
  VALUES (pid, TG_TABLE_NAME, NEW.id, op, rec, NEW.origin_node);

  RETURN NEW;
END
$$;

-- Attaches the standard columns, trigger, and RLS policy to a tenant table, so
-- the rules cannot be forgotten on a table added later in a hurry.
CREATE OR REPLACE FUNCTION luminary.make_tenant_table(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tname text := target::text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tname);
  -- FORCE is the important half: without it the table owner bypasses the policy.
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tname);

  EXECUTE format($f$
    CREATE POLICY tenant_isolation ON %s
      USING (practice_id = luminary.current_practice_id())
      WITH CHECK (practice_id = luminary.current_practice_id())
  $f$, tname);

  EXECUTE format($f$
    CREATE TRIGGER touch_and_log
      BEFORE INSERT OR UPDATE OR DELETE ON %s
      FOR EACH ROW EXECUTE FUNCTION luminary.tg_touch_and_log()
  $f$, tname);

  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO luminary_app', tname);
END
$$;
