-- =============================================================================
-- 007 · Invitation resolution
-- =============================================================================
--
-- The third and final operation that legitimately precedes tenancy. An
-- invitation token, like a session token, carries no practice — the practice is
-- what resolving it tells you. Accepting an invitation therefore hit exactly the
-- same wall as sign-in did: RLS correctly returned zero rows, and the invitation
-- looked expired.
--
-- Same shape of fix as `resolve_session`: one SECURITY DEFINER function, taking
-- a hash, returning at most one row. Creating the account afterwards happens
-- inside a normal tenant-scoped transaction, using the practice this returns.

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

REVOKE ALL ON FUNCTION luminary.resolve_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION luminary.resolve_invitation(text) TO luminary_app;

-- The practice's own password policy, needed before a session exists.
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

REVOKE ALL ON FUNCTION luminary.password_policy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION luminary.password_policy(uuid) TO luminary_app;
