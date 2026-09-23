-- =============================================================================
-- 046 - Allow invitation boundary functions through forced RLS
-- =============================================================================
--
-- The resolver functions are SECURITY DEFINER and owned by luminary_migrator.
-- FORCE ROW LEVEL SECURITY still applies to a table owner, so the ordinary
-- tenant policy hides invitations before a session (and therefore a tenant)
-- exists. These policies apply only while those functions execute as the
-- migration role; luminary_app retains the normal tenant boundary.

SET search_path = luminary, public;

DROP POLICY IF EXISTS invitation_boundary_lookup ON luminary.user_invitation;
CREATE POLICY invitation_boundary_lookup ON luminary.user_invitation
  FOR SELECT
  TO luminary_migrator
  USING (true);

DROP POLICY IF EXISTS password_policy_boundary_lookup ON luminary.practice_settings;
CREATE POLICY password_policy_boundary_lookup ON luminary.practice_settings
  FOR SELECT
  TO luminary_migrator
  USING (true);
