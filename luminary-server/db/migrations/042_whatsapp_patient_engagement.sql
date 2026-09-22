-- =============================================================================
-- 042 - WhatsApp patient intake and post-consultation follow-up foundation
-- =============================================================================

SET search_path = luminary, public;

ALTER TABLE luminary.encounter
  ADD COLUMN IF NOT EXISTS follow_up_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS follow_up_scheduled_for timestamptz;

ALTER TABLE luminary.agent_conversation
  ADD COLUMN IF NOT EXISTS conversation_type text NOT NULL DEFAULT 'general'
    CHECK (conversation_type IN ('general', 'intake', 'followup')),
  ADD COLUMN IF NOT EXISTS workflow_status text NOT NULL DEFAULT 'active'
    CHECK (workflow_status IN ('active', 'handed_over', 'completed', 'closed')),
  ADD COLUMN IF NOT EXISTS encounter_id uuid REFERENCES luminary.encounter(id),
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz;

ALTER TABLE luminary.agent_action
  ADD COLUMN IF NOT EXISTS credential_id uuid REFERENCES luminary.integration_credential(id),
  ADD COLUMN IF NOT EXISTS correlation_id text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS response jsonb;

ALTER TABLE luminary.audit_event
  ADD COLUMN IF NOT EXISTS integration_credential_id uuid REFERENCES luminary.integration_credential(id),
  ADD COLUMN IF NOT EXISTS correlation_id text,
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS result text;

CREATE TABLE luminary.patient_consent_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id     uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id      uuid        NOT NULL REFERENCES luminary.patient(id),
  conversation_id uuid REFERENCES luminary.agent_conversation(id),
  credential_id   uuid REFERENCES luminary.integration_credential(id),
  consent_type    text        NOT NULL CHECK (consent_type IN ('treatment', 'communications', 'data_processing')),
  accepted        boolean     NOT NULL,
  source          text        NOT NULL CHECK (source IN ('whatsapp', 'sms', 'web', 'in_person', 'staff')),
  policy_version  text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  origin_node     text
);

CREATE INDEX patient_consent_patient_idx
  ON luminary.patient_consent_event (practice_id, patient_id, occurred_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE luminary.patient_followup (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id              uuid        NOT NULL REFERENCES luminary.practice(id),
  patient_id               uuid        NOT NULL REFERENCES luminary.patient(id),
  encounter_id             uuid        NOT NULL REFERENCES luminary.encounter(id),
  appointment_id           uuid        NOT NULL REFERENCES luminary.appointment(id),
  conversation_id          uuid REFERENCES luminary.agent_conversation(id),
  status                   text        NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'scheduled', 'queued', 'sent', 'awaiting_response', 'responded',
    'escalated', 'under_review', 'completed', 'cancelled', 'failed', 'expired'
  )),
  scheduled_for            timestamptz,
  sent_at                  timestamptz,
  responded_at             timestamptz,
  summary                  text,
  structured_response      jsonb,
  symptom_status           text CHECK (symptom_status IS NULL OR symptom_status IN (
    'resolved', 'improving', 'unchanged', 'worsening', 'new_symptoms', 'unknown'
  )),
  medication_adherence     text CHECK (medication_adherence IS NULL OR medication_adherence IN (
    'as_directed', 'partial', 'not_taking', 'not_applicable', 'unknown'
  )),
  requires_clinical_review boolean     NOT NULL DEFAULT false,
  escalation_level         text CHECK (escalation_level IS NULL OR escalation_level IN ('routine', 'priority', 'urgent')),
  review_reason            text,
  assigned_to              uuid REFERENCES luminary.app_user(id),
  reviewed_by              uuid REFERENCES luminary.app_user(id),
  reviewed_at              timestamptz,
  completed_at             timestamptz,
  idempotency_key          text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  origin_node              text,
  CONSTRAINT patient_followup_escalation_consistent CHECK (
    status NOT IN ('escalated', 'under_review') OR requires_clinical_review
  ),
  CONSTRAINT patient_followup_completion_consistent CHECK (
    status <> 'completed' OR (completed_at IS NOT NULL AND NOT requires_clinical_review)
  )
);

CREATE UNIQUE INDEX patient_followup_active_encounter_idx
  ON luminary.patient_followup (practice_id, encounter_id)
  WHERE deleted_at IS NULL
    AND status NOT IN ('completed', 'cancelled', 'failed', 'expired');

CREATE UNIQUE INDEX patient_followup_idempotency_idx
  ON luminary.patient_followup (practice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX patient_followup_review_idx
  ON luminary.patient_followup (practice_id, requires_clinical_review, escalation_level, created_at)
  WHERE deleted_at IS NULL AND requires_clinical_review;

CREATE OR REPLACE FUNCTION luminary.practices_with_missing_followups()
RETURNS TABLE (practice_id uuid, missing bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = luminary, public
AS $$
  SELECT e.practice_id, count(*)
    FROM luminary.encounter e
    JOIN luminary.appointment a
      ON a.id = e.appointment_id AND a.practice_id = e.practice_id
   WHERE e.deleted_at IS NULL AND a.deleted_at IS NULL
     AND e.follow_up_required = true
     AND e.status IN ('signed', 'amended')
     AND a.status = 'completed'
     AND NOT EXISTS (
       SELECT 1 FROM luminary.patient_followup f
        WHERE f.practice_id = e.practice_id
          AND f.encounter_id = e.id
          AND f.deleted_at IS NULL
          AND f.status NOT IN ('completed', 'cancelled', 'failed', 'expired')
     )
   GROUP BY e.practice_id
$$;

REVOKE ALL ON FUNCTION luminary.practices_with_missing_followups() FROM public;
GRANT EXECUTE ON FUNCTION luminary.practices_with_missing_followups() TO luminary_app;

ALTER TABLE luminary.agent_conversation
  ADD COLUMN IF NOT EXISTS followup_id uuid REFERENCES luminary.patient_followup(id);

ALTER TABLE luminary.message
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES luminary.agent_conversation(id),
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE luminary.inbound_message
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES luminary.agent_conversation(id);

CREATE UNIQUE INDEX message_integration_idempotency_idx
  ON luminary.message (practice_id, sent_via_credential, idempotency_key)
  WHERE sent_via_credential IS NOT NULL AND idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION luminary.enforce_patient_followup_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_row record;
  appointment_row record;
  conversation_row record;
BEGIN
  IF current_setting('luminary.replicating', true) = 'on' THEN RETURN NEW; END IF;
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.assigned_to, 'Assigned user');
  PERFORM luminary.require_same_practice('luminary.app_user', NEW.reviewed_by, 'Reviewing user');

  SELECT patient_id, appointment_id, status, follow_up_required
    INTO encounter_row
    FROM luminary.encounter
   WHERE id = NEW.encounter_id
     AND practice_id = luminary.current_practice_id()
     AND deleted_at IS NULL;
  IF encounter_row.patient_id IS NULL THEN
    RAISE EXCEPTION 'Encounter is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF encounter_row.patient_id IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Follow-up encounter must belong to the patient' USING ERRCODE = '23514';
  END IF;
  IF encounter_row.appointment_id IS DISTINCT FROM NEW.appointment_id THEN
    RAISE EXCEPTION 'Follow-up appointment must be the encounter appointment' USING ERRCODE = '23514';
  END IF;

  SELECT patient_id, status INTO appointment_row
    FROM luminary.appointment
   WHERE id = NEW.appointment_id
     AND practice_id = luminary.current_practice_id()
     AND deleted_at IS NULL;
  IF appointment_row.patient_id IS NULL THEN
    RAISE EXCEPTION 'Appointment is not in this practice' USING ERRCODE = '23514';
  END IF;
  IF appointment_row.patient_id IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'Follow-up appointment must belong to the patient' USING ERRCODE = '23514';
  END IF;

  IF NEW.conversation_id IS NOT NULL THEN
    SELECT patient_id INTO conversation_row
      FROM luminary.agent_conversation
     WHERE id = NEW.conversation_id
       AND practice_id = luminary.current_practice_id()
       AND deleted_at IS NULL;
    IF conversation_row.patient_id IS NULL OR conversation_row.patient_id IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Follow-up conversation must be bound to the patient' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER enforce_patient_followup_refs
BEFORE INSERT OR UPDATE OF practice_id, patient_id, encounter_id, appointment_id,
  conversation_id, assigned_to, reviewed_by
ON luminary.patient_followup
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_patient_followup_refs();

CREATE OR REPLACE FUNCTION luminary.enforce_agent_conversation_workflow_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  encounter_patient uuid;
  followup_patient uuid;
BEGIN
  IF current_setting('luminary.replicating', true) = 'on' THEN RETURN NEW; END IF;
  PERFORM luminary.require_same_practice('luminary.integration_credential', NEW.credential_id, 'Credential');
  PERFORM luminary.require_same_practice('luminary.patient', NEW.patient_id, 'Patient');
  IF NEW.encounter_id IS NOT NULL THEN
    SELECT patient_id INTO encounter_patient FROM luminary.encounter
     WHERE id = NEW.encounter_id AND practice_id = luminary.current_practice_id() AND deleted_at IS NULL;
    IF encounter_patient IS NULL OR encounter_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Conversation encounter must belong to the patient' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.followup_id IS NOT NULL THEN
    SELECT patient_id INTO followup_patient FROM luminary.patient_followup
     WHERE id = NEW.followup_id AND practice_id = luminary.current_practice_id() AND deleted_at IS NULL;
    IF followup_patient IS NULL OR followup_patient IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'Conversation follow-up must belong to the patient' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER enforce_agent_conversation_workflow_refs
BEFORE INSERT OR UPDATE OF practice_id, credential_id, patient_id, encounter_id, followup_id
ON luminary.agent_conversation
FOR EACH ROW EXECUTE FUNCTION luminary.enforce_agent_conversation_workflow_refs();

CREATE OR REPLACE FUNCTION luminary.write_audit(
  p_action text,
  p_subject_type text DEFAULT NULL,
  p_subject_id uuid DEFAULT NULL,
  p_subject_name text DEFAULT NULL,
  p_detail text DEFAULT NULL,
  p_severity text DEFAULT 'info'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
  v_name text;
  v_role text;
  v_credential uuid := NULLIF(current_setting('luminary.integration_credential_id', true), '')::uuid;
BEGIN
  SELECT display_name, role INTO v_name, v_role
    FROM luminary.app_user WHERE id = luminary.current_user_id();

  INSERT INTO luminary.audit_event (
    practice_id, actor_id, actor_name, actor_role, action, subject_type,
    subject_id, subject_name, detail, severity, origin_node,
    integration_credential_id, correlation_id, request_id, result
  ) VALUES (
    luminary.current_practice_id(), luminary.current_user_id(),
    COALESCE(v_name, CASE WHEN v_credential IS NULL THEN 'unknown' ELSE 'integration' END), v_role,
    p_action, p_subject_type, p_subject_id, p_subject_name, p_detail, p_severity,
    luminary.current_node(), v_credential,
    NULLIF(current_setting('luminary.correlation_id', true), ''),
    NULLIF(current_setting('luminary.request_id', true), ''),
    NULLIF(current_setting('luminary.operation_result', true), '')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

SELECT luminary.make_tenant_table('luminary.patient_consent_event');
SELECT luminary.make_tenant_table('luminary.patient_followup');

-- Consent evidence is append-only. Replication inserts an absent row and never
-- needs to rewrite evidence already present on a node.
CREATE OR REPLACE FUNCTION luminary.tg_consent_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'patient_consent_event is append-only'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER consent_no_update
BEFORE UPDATE ON luminary.patient_consent_event
FOR EACH ROW EXECUTE FUNCTION luminary.tg_consent_append_only();

CREATE TRIGGER consent_no_delete
BEFORE DELETE ON luminary.patient_consent_event
FOR EACH ROW EXECUTE FUNCTION luminary.tg_consent_append_only();
