-- =============================================================================
-- 005 · Audit trail
-- =============================================================================
--
-- The audit table is append-only because the DATABASE says so, not because the
-- application intends to be well behaved. `luminary_app` is granted INSERT and
-- SELECT and nothing else; there is no UPDATE or DELETE grant to revoke later,
-- and a trigger refuses both regardless of who is asking.
--
-- This matters more than it looks. Break-glass, role changes, and chart access
-- are all controls whose entire force comes from being recorded. A trail that
-- can be edited by the same process that writes it is not evidence, it is a
-- log file with a compliance label on it.

SET search_path = luminary, public;

CREATE TABLE luminary.audit_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id  uuid        NOT NULL REFERENCES luminary.practice(id),
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  -- Taken from the authenticated session, never from the request body. A client
  -- must not be able to choose whose name appears against an action.
  actor_id     uuid REFERENCES luminary.app_user(id),
  actor_name   text        NOT NULL,
  actor_role   text,

  action       text        NOT NULL,
  subject_type text,
  subject_id   uuid,
  subject_name text,
  detail       text,
  severity     text        NOT NULL DEFAULT 'info' CHECK (severity IN ('info','notice','alert')),

  ip           inet,
  user_agent   text,
  origin_node  text        NOT NULL DEFAULT 'unknown'
);

CREATE INDEX audit_practice_time_idx ON luminary.audit_event (practice_id, occurred_at DESC);
CREATE INDEX audit_actor_idx         ON luminary.audit_event (practice_id, actor_id, occurred_at DESC);
-- Break-glass and other alerts need reviewing, so give them their own index:
-- a control nobody reviews is decorative.
CREATE INDEX audit_alert_idx         ON luminary.audit_event (practice_id, occurred_at DESC)
  WHERE severity = 'alert';

CREATE OR REPLACE FUNCTION luminary.tg_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON luminary.audit_event
  FOR EACH ROW EXECUTE FUNCTION luminary.tg_audit_append_only();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON luminary.audit_event
  FOR EACH ROW EXECUTE FUNCTION luminary.tg_audit_append_only();

-- Tenant isolation applies here too: one practice must never read another's
-- access history. Note this table gets its policy by hand rather than through
-- make_tenant_table(), because it must NOT have the touch-and-log trigger
-- (audit changes are not themselves synced as domain changes) and must not be
-- granted UPDATE.
ALTER TABLE luminary.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE luminary.audit_event FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON luminary.audit_event
  USING (practice_id = luminary.current_practice_id())
  WITH CHECK (practice_id = luminary.current_practice_id());

GRANT SELECT, INSERT ON luminary.audit_event TO luminary_app;

-- Convenience writer used by the API. SECURITY DEFINER so the actor columns are
-- filled from the session context rather than trusted from the caller.
CREATE OR REPLACE FUNCTION luminary.write_audit(
  p_action       text,
  p_subject_type text DEFAULT NULL,
  p_subject_id   uuid DEFAULT NULL,
  p_subject_name text DEFAULT NULL,
  p_detail       text DEFAULT NULL,
  p_severity     text DEFAULT 'info'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
  v_name text;
  v_role text;
BEGIN
  SELECT display_name, role INTO v_name, v_role
    FROM luminary.app_user WHERE id = luminary.current_user_id();

  INSERT INTO luminary.audit_event (
    practice_id, actor_id, actor_name, actor_role,
    action, subject_type, subject_id, subject_name, detail, severity, origin_node
  ) VALUES (
    luminary.current_practice_id(), luminary.current_user_id(),
    COALESCE(v_name, 'unknown'), v_role,
    p_action, p_subject_type, p_subject_id, p_subject_name, p_detail, p_severity,
    luminary.current_node()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION luminary.write_audit(text, text, uuid, text, text, text) TO luminary_app;

-- Opening a chart is itself an auditable event, and the reason it was allowed
-- is part of the record. Called by the API on every chart read.
CREATE OR REPLACE FUNCTION luminary.log_chart_access(p_patient uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_reason text;
  v_name   text;
BEGIN
  SELECT full_name INTO v_name FROM luminary.patient WHERE id = p_patient;
  v_reason := luminary.care_relationship(luminary.current_user_id(), p_patient);

  PERFORM luminary.write_audit(
    CASE WHEN v_reason IS NULL THEN 'Chart access without relationship' ELSE 'Viewed chart' END,
    'patient', p_patient, v_name,
    COALESCE(v_reason, 'no standing care relationship'),
    CASE WHEN v_reason IS NULL THEN 'alert' ELSE 'info' END
  );

  RETURN v_reason;
END
$$;

GRANT EXECUTE ON FUNCTION luminary.log_chart_access(uuid) TO luminary_app;
GRANT EXECUTE ON FUNCTION luminary.care_relationship(uuid, uuid) TO luminary_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA luminary TO luminary_app;
GRANT SELECT ON luminary.practice TO luminary_app;
GRANT SELECT, INSERT, UPDATE ON luminary.sync_change, luminary.sync_peer, luminary.sync_conflict TO luminary_app;
