-- =============================================================================
-- 038 - Runtime grants for sync metadata written by table triggers
-- =============================================================================
--
-- Tenant tables use BEFORE triggers to append rows to sync_change. Those
-- triggers execute during ordinary application writes such as sign-in session
-- creation, so the runtime role needs the narrow metadata permissions below.

SET search_path = luminary, public;

GRANT SELECT, INSERT, UPDATE ON luminary.sync_change TO luminary_app;
GRANT USAGE, SELECT ON SEQUENCE luminary.sync_change_seq TO luminary_app;

GRANT SELECT, INSERT, UPDATE ON luminary.sync_peer TO luminary_app;
GRANT SELECT, INSERT, UPDATE ON luminary.sync_conflict TO luminary_app;
