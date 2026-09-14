-- =============================================================================
-- 013 · Snapshot backfill for a new node
-- =============================================================================
--
-- Replication works forward from the change log, so a node brought up against
-- an established practice started empty and received only what changed
-- afterwards. Everything written before it existed was invisible to it, with no
-- error anywhere — the clinic simply had a server that agreed about today and
-- knew nothing about last year.
--
-- The missing piece is a seed: copy the practice's current rows, record where
-- the change log stood when that copy was taken, and stream forward from there.
-- One column is enough to make that resumable and idempotent — without it a
-- restart mid-copy would either start over or, worse, stop early and leave a
-- node permanently short of rows while reporting itself up to date.
--
-- NULL means "never seeded", which is what every existing row already says, so
-- established pairs backfill once on their next cycle and never again.

SET search_path = luminary, public;

ALTER TABLE luminary.sync_peer
  ADD COLUMN IF NOT EXISTS backfilled_at timestamptz;

COMMENT ON COLUMN luminary.sync_peer.backfilled_at IS
  'When this node finished seeding itself from the peer. NULL means the peer''s pre-existing rows have never been copied here, and incremental sync alone will not surface them.';
