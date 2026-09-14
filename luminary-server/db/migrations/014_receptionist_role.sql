-- =============================================================================
-- 014 · Receptionist role
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.app_user
  DROP CONSTRAINT app_user_role_check,
  ADD CONSTRAINT app_user_role_check
    CHECK (role IN ('admin', 'doctor', 'nurse', 'manager', 'receptionist'));
