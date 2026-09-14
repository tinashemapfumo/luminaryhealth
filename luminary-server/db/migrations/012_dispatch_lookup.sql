-- =============================================================================
-- 012 · Dispatcher lookup
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The dispatcher runs outside any one practice, so it needs to know *which*
-- practices have work waiting before it can enter a tenant context. That is a
-- genuine cross-tenant read, so it gets the same shape as the other three
-- (sign-in, session resolution, invitation acceptance): a SECURITY DEFINER
-- function with the narrowest possible return. It returns practice ids and
-- counts — never a recipient, never a message body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION luminary.practices_with_queued_messages()
RETURNS TABLE (practice_id uuid, queued bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = luminary, public
AS $$
  SELECT m.practice_id, count(*)
    FROM luminary.message m
   WHERE m.status = 'queued' AND m.deleted_at IS NULL AND m.attempts < 5
   GROUP BY m.practice_id
$$;

REVOKE ALL ON FUNCTION luminary.practices_with_queued_messages() FROM public;
GRANT EXECUTE ON FUNCTION luminary.practices_with_queued_messages() TO luminary_app;
