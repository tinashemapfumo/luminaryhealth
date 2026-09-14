-- =============================================================================
-- 040 - Invitation boundary function ownership
-- =============================================================================
--
-- Invitation acceptance resolves an opaque token before any tenant session
-- exists. With FORCE ROW LEVEL SECURITY enabled, the SECURITY DEFINER function
-- must be owned by a role that can cross that pre-tenant boundary; otherwise a
-- valid, unexpired invitation is hidden by RLS and reported as invalid/expired.

SET search_path = luminary, public;

CREATE OR REPLACE FUNCTION luminary.resolve_invitation(p_token_hash text)
RETURNS TABLE (
  invitation_id uuid,
  practice_id   uuid,
  email         citext,
  role          text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = luminary, public
AS $$
  SELECT i.id, i.practice_id, i.email, i.role
    FROM luminary.user_invitation i
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL
     AND i.expires_at > now()
     AND i.deleted_at IS NULL
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION luminary.password_policy(p_practice_id uuid)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = luminary, public
AS $$
  SELECT COALESCE(
    (SELECT minimum_password_length FROM luminary.practice_settings WHERE practice_id = p_practice_id),
    12);
$$;

ALTER FUNCTION luminary.resolve_invitation(text) OWNER TO postgres;
ALTER FUNCTION luminary.password_policy(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION luminary.resolve_invitation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION luminary.password_policy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION luminary.resolve_invitation(text) TO luminary_app;
GRANT EXECUTE ON FUNCTION luminary.password_policy(uuid) TO luminary_app;
