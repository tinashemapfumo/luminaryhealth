-- =============================================================================
-- 006 · The authentication boundary
-- =============================================================================
--
-- Sign-in and token resolution are the two operations that legitimately precede
-- tenancy: you cannot scope a query to a practice you have not yet established.
-- Running them without context returns zero rows — correct fail-closed
-- behaviour that nonetheless makes signing in impossible.
--
-- The fix is a narrow, auditable hole rather than a broad one:
--
--   * Sign-in does NOT need a hole at all. The caller states which practice
--     they are signing in to, so the API sets that as the context and lets RLS
--     scope the lookup. Claiming the wrong practice simply finds no user. The
--     client is choosing what to *scope to*, not what to *access* — the password
--     check still has to pass, so this grants nothing.
--
--   * Token resolution genuinely cannot work that way: a bearer token carries no
--     practice. `resolve_session` is therefore SECURITY DEFINER, but it takes a
--     SHA-256 hash and returns at most one row. It is the only function in the
--     system that reads across tenants, which makes it the one place to look
--     when auditing that boundary.

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

REVOKE ALL ON FUNCTION luminary.resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION luminary.resolve_session(text) TO luminary_app;

-- Revoking a session shares the problem: the holder proves possession of the
-- token, not membership of a practice.
CREATE OR REPLACE FUNCTION luminary.revoke_session(p_token_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = luminary, public
AS $$
  UPDATE luminary.session SET revoked_at = now()
   WHERE token_hash = p_token_hash AND revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION luminary.revoke_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION luminary.revoke_session(text) TO luminary_app;
