-- =============================================================================
-- 039 - Auth boundary function ownership
-- =============================================================================
--
-- /auth/session creates a tenant-scoped session row. /auth/me then resolves an
-- opaque bearer token before the tenant is known, so resolve_session is the one
-- narrow SECURITY DEFINER boundary that must be able to read across tenant RLS.
-- On production this function may have been owned by a non-bypass role, which
-- makes sign-in return a token that cannot be resolved afterward.

SET search_path = luminary, public;

CREATE OR REPLACE FUNCTION luminary.resolve_session(p_token_hash text)
RETURNS TABLE (
  session_id           uuid,
  practice_id          uuid,
  user_id              uuid,
  role                 text,
  display_name         text,
  active               boolean,
  registration_expires date,
  enforce_registration boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = luminary, public
AS $$
  SELECT s.id, s.practice_id, u.id, u.role, u.display_name, u.active,
         u.registration_expires, COALESCE(ps.enforce_registration, true)
    FROM luminary.session s
    JOIN luminary.app_user u ON u.id = s.user_id
    LEFT JOIN luminary.practice_settings ps ON ps.practice_id = s.practice_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.deleted_at IS NULL
     AND u.active
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION luminary.revoke_session(p_token_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = luminary, public
AS $$
  UPDATE luminary.session
     SET revoked_at = now()
   WHERE token_hash = p_token_hash
     AND revoked_at IS NULL;
$$;

ALTER FUNCTION luminary.resolve_session(text) OWNER TO CURRENT_USER;
ALTER FUNCTION luminary.revoke_session(text) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION luminary.resolve_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION luminary.revoke_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION luminary.resolve_session(text) TO luminary_app;
GRANT EXECUTE ON FUNCTION luminary.revoke_session(text) TO luminary_app;
