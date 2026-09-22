import type { PoolClient } from 'pg';
import { BadRequest, Conflict, NotFound } from '../../platform/errors.js';
import type { Conversation } from './agent.service.js';

export const FOLLOWUP_STATES = [
  'pending', 'scheduled', 'queued', 'sent', 'awaiting_response', 'responded',
  'escalated', 'under_review', 'completed', 'cancelled', 'failed', 'expired',
] as const;

const REVIEW_REASON_CODES = new Set([
  'worsening_symptoms', 'new_symptoms', 'medication_problem', 'patient_requested_review',
  'possible_emergency', 'uncertain_response',
]);

const RED_FLAG_REASONS = new Set(['possible_emergency']);

export const followupService = {
  async ensureIfEligible(client: PoolClient, encounterId: string) {
    const { rows } = await client.query(
      `SELECT e.follow_up_required, e.status AS encounter_status, a.status AS appointment_status
         FROM luminary.encounter e
         LEFT JOIN luminary.appointment a ON a.id = e.appointment_id
        WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [encounterId],
    );
    const row = rows[0];
    if (!row?.follow_up_required || !['signed', 'amended'].includes(row.encounter_status)
        || row.appointment_status !== 'completed') return null;
    return this.ensureForEncounter(client, encounterId, null);
  },

  async ensureForEncounter(
    client: PoolClient,
    encounterId: string,
    idempotencyKey?: string | null,
    expectedPatientId?: string | null,
  ) {
    const { rows } = await client.query(
      `SELECT e.id, e.patient_id, e.appointment_id, e.status AS encounter_status,
              e.follow_up_required, e.follow_up_scheduled_for,
              a.status AS appointment_status
         FROM luminary.encounter e
         JOIN luminary.appointment a ON a.id = e.appointment_id
        WHERE e.id = $1
          AND e.practice_id = luminary.current_practice_id()
          AND a.practice_id = luminary.current_practice_id()
          AND e.deleted_at IS NULL AND a.deleted_at IS NULL`,
      [encounterId],
    );
    const eligible = rows[0];
    if (!eligible) throw new NotFound('Encounter not found');
    if (expectedPatientId && eligible.patient_id !== expectedPatientId) {
      throw new NotFound('Encounter not found');
    }
    if (!eligible.follow_up_required) {
      throw new Conflict('This encounter does not require a patient follow-up');
    }
    if (!['signed', 'amended'].includes(eligible.encounter_status)
        || eligible.appointment_status !== 'completed') {
      throw new Conflict('Follow-up requires a completed appointment and signed encounter');
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO luminary.patient_followup
         (practice_id, patient_id, encounter_id, appointment_id, status, scheduled_for, idempotency_key)
       VALUES (
         luminary.current_practice_id(), $1, $2, $3,
         CASE WHEN $4::timestamptz IS NULL THEN 'pending' ELSE 'scheduled' END,
         $4, $5
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        eligible.patient_id, eligible.id, eligible.appointment_id,
        eligible.follow_up_scheduled_for, idempotencyKey ?? null,
      ],
    );
    if (inserted[0]) {
      await client.query(
        `SELECT luminary.write_audit('Created patient follow-up', 'patient_followup', $1, NULL, $2, 'notice')`,
        [inserted[0].id, eligible.id],
      );
      return { followup: inserted[0], replayed: false };
    }

    const { rows: existing } = await client.query(
      `SELECT * FROM luminary.patient_followup
        WHERE encounter_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [encounterId],
    );
    if (!existing[0]) throw new Conflict('That idempotency key is already in use');
    return { followup: existing[0], replayed: true };
  },

  async getForConversation(client: PoolClient, id: string, conversation: Conversation) {
    const { rows } = await client.query(
      `SELECT id, status, scheduled_for, sent_at, responded_at,
              symptom_status, medication_adherence,
              requires_clinical_review, escalation_level, completed_at
         FROM luminary.patient_followup
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
      [id, conversation.patient_id],
    );
    if (!rows[0]) throw new NotFound('Follow-up not found');
    return rows[0];
  },

  async attachConversation(client: PoolClient, id: string, conversation: Conversation) {
    const patientId = conversation.patient_id;
    if (!patientId) throw new Conflict('Conversation is not bound to a patient');
    const { rows } = await client.query(
      `UPDATE luminary.patient_followup
          SET conversation_id = $2
        WHERE id = $1 AND patient_id = $3 AND deleted_at IS NULL
        RETURNING *`,
      [id, conversation.id, patientId],
    );
    if (!rows[0]) throw new NotFound('Follow-up not found');
    await client.query(
      `UPDATE luminary.agent_conversation
          SET conversation_type = 'followup', followup_id = $2, encounter_id = $3
        WHERE id = $1`,
      [conversation.id, id, rows[0].encounter_id],
    );
    return rows[0];
  },

  async recordResponse(
    client: PoolClient,
    followupId: string,
    conversation: Conversation,
    input: {
      responseKey: string; summary: string; patientResponse: Record<string, unknown>;
      symptomStatus: string; medicationAdherence: string; requiresClinicalReview: boolean;
    },
  ) {
    const prior = await this.replayAction(client, conversation.id, input.responseKey, 'followup_response');
    if (prior) return { followupId: prior.subject_id, replayed: true };

    const deterministicReview = ['worsening', 'new_symptoms', 'unknown'].includes(input.symptomStatus)
      || ['partial', 'not_taking', 'unknown'].includes(input.medicationAdherence);
    const requiresReview = input.requiresClinicalReview || deterministicReview;
    const { rows } = await client.query(
      `UPDATE luminary.patient_followup
          SET status = CASE WHEN $6 THEN 'escalated' ELSE 'responded' END,
              responded_at = COALESCE(responded_at, now()),
              summary = COALESCE(summary, $3),
              structured_response = COALESCE(structured_response, $4::jsonb),
              symptom_status = COALESCE(symptom_status, $5),
              medication_adherence = COALESCE(medication_adherence, $7),
              requires_clinical_review = $6,
              escalation_level = CASE WHEN $6 THEN COALESCE(escalation_level, 'priority') ELSE NULL END,
              review_reason = CASE WHEN $6 THEN COALESCE(review_reason, 'Structured response requires review') ELSE NULL END
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL
          AND status IN ('sent', 'awaiting_response', 'scheduled', 'pending')
        RETURNING *`,
      [
        followupId, conversation.patient_id, input.summary,
        JSON.stringify(input.patientResponse), input.symptomStatus,
        requiresReview, input.medicationAdherence,
      ],
    );
    if (!rows[0]) throw new Conflict('Follow-up cannot accept a response in its current state');
    return { followup: rows[0], replayed: false, requiresClinicalReview: requiresReview };
  },

  async escalate(
    client: PoolClient,
    followupId: string,
    conversation: Conversation,
    input: { requestKey: string; level: string; reasonCode: string; summary: string },
  ) {
    if (!REVIEW_REASON_CODES.has(input.reasonCode)) throw new BadRequest('Unknown escalation reason');
    const prior = await this.replayAction(client, conversation.id, input.requestKey, 'followup_escalation');
    if (prior) return { followupId: prior.subject_id, replayed: true };
    const level = RED_FLAG_REASONS.has(input.reasonCode) ? 'urgent' : input.level;
    const { rows } = await client.query(
      `UPDATE luminary.patient_followup
          SET status = 'escalated', requires_clinical_review = true,
              escalation_level = $3, review_reason = $4,
              summary = COALESCE(summary, $5)
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL
          AND status NOT IN ('completed', 'cancelled', 'failed', 'expired')
        RETURNING *`,
      [followupId, conversation.patient_id, level, input.reasonCode, input.summary],
    );
    if (!rows[0]) throw new Conflict('Follow-up cannot be escalated in its current state');
    await client.query(
      `SELECT luminary.write_audit('Escalated patient follow-up', 'patient_followup', $1, NULL, $2, 'alert')`,
      [followupId, `${level}: ${input.reasonCode}`],
    );
    return { followup: rows[0], replayed: false };
  },

  async complete(client: PoolClient, id: string, conversation: Conversation) {
    const { rows } = await client.query(
      `UPDATE luminary.patient_followup
          SET status = 'completed', completed_at = now()
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL
          AND status = 'responded' AND requires_clinical_review = false
        RETURNING *`,
      [id, conversation.patient_id],
    );
    if (!rows[0]) throw new Conflict('Only a non-escalated responded follow-up can be completed');
    return rows[0];
  },

  async review(client: PoolClient, id: string, userId: string, complete: boolean) {
    const { rows } = await client.query(
      `UPDATE luminary.patient_followup
          SET status = CASE WHEN $3 THEN 'completed' ELSE 'under_review' END,
              reviewed_by = $2, reviewed_at = now(),
              requires_clinical_review = CASE WHEN $3 THEN false ELSE true END,
              completed_at = CASE WHEN $3 THEN now() ELSE completed_at END
        WHERE id = $1 AND requires_clinical_review = true AND deleted_at IS NULL
        RETURNING *`,
      [id, userId, complete],
    );
    if (!rows[0]) throw new NotFound('Follow-up requiring review not found');
    return rows[0];
  },

  async replayAction(client: PoolClient, conversationId: string, key: string, expectedTool: string) {
    const { rows } = await client.query(
      `SELECT subject_id, tool FROM luminary.agent_action
        WHERE conversation_id = $1 AND request_key = $2 AND outcome = 'ok' AND deleted_at IS NULL`,
      [conversationId, key],
    );
    const action = rows[0] ?? null;
    if (action && action.tool !== expectedTool) {
      throw new Conflict('Idempotency key was already used for another operation');
    }
    return action;
  },
};
