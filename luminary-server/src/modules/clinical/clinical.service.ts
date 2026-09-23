import type { PoolClient } from 'pg';
import { can, type Role } from '../../platform/permissions.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';
import { patientFileStream, removePatientFile, storePatientFile } from '../../platform/file-storage.js';
import { assertSamePatient, requireEncounterInTenant, requirePatientInTenant } from '../../platform/tenant-refs.js';
import { catalogueRepository } from '../catalogue/catalogue.repository.js';
import { catalogueService } from '../catalogue/catalogue.service.js';
import { followupService } from '../agent/followup.service.js';

/**
 * Clinical documentation.
 *
 * The rules that matter are about signing, and they are enforced in three
 * places on purpose: the database freezes a signed note by trigger, this
 * service refuses to sign an incomplete one, and the route requires the
 * `signNote` permission. Any single layer failing still leaves the record
 * defensible.
 *
 * A lapsed practising registration blocks signing and prescribing but not
 * reading or drafting — locking a clinician out of the record entirely because
 * their council renewal is late would harm patients more than it protects them.
 */

export interface Actor {
  userId: string;
  role: Role;
  practiceId: string;
  registrationLapsed: boolean;
}

const REQUIRED_TO_SIGN = ['subjective', 'objective', 'assessment', 'plan'] as const;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/dicom',
]);

const toneForLab = (abnormal: boolean) => abnormal ? 'alert' : 'success';

type ContributionType = 'triage' | 'vitals' | 'clinical_note' | 'diagnosis' | 'signing';

async function recordContributor(
  client: PoolClient,
  encounterId: string,
  userId: string,
  contributionType: ContributionType,
) {
  await client.query(
    `INSERT INTO luminary.encounter_contributor
       (practice_id, encounter_id, user_id, contribution_type)
     VALUES (luminary.current_practice_id(), $1, $2, $3)
     ON CONFLICT (practice_id, encounter_id, user_id, contribution_type)
     DO UPDATE SET last_contributed_at = now(), deleted_at = NULL`,
    [encounterId, userId, contributionType],
  );
}

export const clinicalService = {
  async listForPatient(client: PoolClient, actor: Actor, patientId: string) {
    if (!can(actor.role, 'viewClinicalNotes')) {
      throw new Forbidden('Your role does not include clinical notes');
    }
    const { rows } = await client.query(
      `SELECT e.id, e.patient_id, e.appointment_id, e.note_type, e.status,
              e.subjective, e.objective, e.assessment, e.plan, e.diagnoses,
              e.follow_up, e.follow_up_required, e.follow_up_scheduled_for,
              e.vitals, e.created_at, e.signed_at, e.triage_completed_at,
              author.display_name AS author_name,
              author.display_name AS created_by_name,
              signer.display_name AS signed_by_name,
              COALESCE(contributors.items, '[]'::jsonb) AS contributors,
              (SELECT count(*)::int FROM luminary.encounter_addendum a
                WHERE a.encounter_id = e.id AND a.deleted_at IS NULL) AS addendum_count
         FROM luminary.encounter e
         JOIN luminary.app_user author ON author.id = e.author_id
         LEFT JOIN luminary.app_user signer ON signer.id = e.signed_by
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'userId', c.user_id,
                      'name', u.display_name,
                      'type', c.contribution_type,
                      'firstContributedAt', c.first_contributed_at,
                      'lastContributedAt', c.last_contributed_at
                    )
                    ORDER BY c.first_contributed_at
                  ) AS items
             FROM luminary.encounter_contributor c
             JOIN luminary.app_user u ON u.id = c.user_id
            WHERE c.encounter_id = e.id AND c.deleted_at IS NULL
         ) contributors ON true
        WHERE e.patient_id = $1 AND e.deleted_at IS NULL
        ORDER BY e.created_at DESC`,
      [patientId],
    );
    return rows;
  },

  async get(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'viewClinicalNotes')) {
      throw new Forbidden('Your role does not include clinical notes');
    }
    const { rows } = await client.query(
      `SELECT e.*, p.full_name AS patient_name, p.allergies, p.allergies_reviewed,
              author.display_name AS author_name,
              author.display_name AS created_by_name,
              signer.display_name AS signed_by_name,
              triage.display_name AS triage_completed_by_name,
              vitals_user.display_name AS vitals_by_name,
              COALESCE(contributors.items, '[]'::jsonb) AS contributors
         FROM luminary.encounter e
         JOIN luminary.patient p ON p.id = e.patient_id
         JOIN luminary.app_user author ON author.id = e.author_id
         LEFT JOIN luminary.app_user signer ON signer.id = e.signed_by
         LEFT JOIN luminary.app_user triage ON triage.id = e.triage_completed_by
         LEFT JOIN luminary.app_user vitals_user ON vitals_user.id = e.vitals_by
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'userId', c.user_id,
                      'name', u.display_name,
                      'type', c.contribution_type,
                      'firstContributedAt', c.first_contributed_at,
                      'lastContributedAt', c.last_contributed_at
                    )
                    ORDER BY c.first_contributed_at
                  ) AS items
             FROM luminary.encounter_contributor c
             JOIN luminary.app_user u ON u.id = c.user_id
            WHERE c.encounter_id = e.id AND c.deleted_at IS NULL
         ) contributors ON true
        WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [id],
    );
    if (!rows[0]) throw new NotFound('Note not found');

    const { rows: addenda } = await client.query(
      `SELECT a.body, a.created_at, u.display_name AS author_name
         FROM luminary.encounter_addendum a
         JOIN luminary.app_user u ON u.id = a.author_id
        WHERE a.encounter_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.created_at`,
      [id],
    );
    return { ...rows[0], addenda };
  },

  async listDocuments(client: PoolClient, actor: Actor, patientId: string) {
    if (!can(actor.role, 'viewClinicalNotes')) {
      throw new Forbidden('Your role does not include clinical documents');
    }
    const { rows } = await client.query(
      `SELECT d.id, d.patient_id, d.encounter_id, d.kind, d.filename, d.content_type,
              d.byte_size, d.checksum, d.notes, d.created_at,
              u.display_name AS uploaded_by_name
         FROM luminary.patient_document d
         JOIN luminary.app_user u ON u.id = d.uploaded_by
        WHERE d.patient_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC`,
      [patientId],
    );
    return rows;
  },

  async listClinicalSummary(client: PoolClient, actor: Actor, patientId: string) {
    if (!can(actor.role, 'viewClinicalNotes')) {
      throw new Forbidden('Your role does not include clinical records');
    }
    const [labs, prescriptions, carePlans, referrals] = await Promise.all([
      client.query(
        `SELECT l.id, l.patient_id, l.encounter_id, l.order_id, l.test_name, l.value,
                l.unit, l.normal_range, l.abnormal, l.resulted_on, l.reviewed_at,
                o.status AS order_status, o.priority AS order_priority,
                o.service_id, s.display_name AS service_name,
                ordered.display_name AS ordered_by_name,
                u.display_name AS reviewed_by_name
           FROM luminary.lab_result l
           LEFT JOIN luminary.clinical_order o ON o.id = l.order_id
           LEFT JOIN luminary.service s ON s.id = o.service_id
           LEFT JOIN luminary.app_user ordered ON ordered.id = o.ordered_by
           LEFT JOIN luminary.app_user u ON u.id = l.reviewed_by
          WHERE l.patient_id = $1 AND l.deleted_at IS NULL
          ORDER BY l.resulted_on DESC NULLS LAST, l.created_at DESC`,
        [patientId],
      ),
      client.query(
        `SELECT p.id, p.patient_id, p.encounter_id, p.drug, p.form, p.strength, p.dose, p.route,
                p.frequency, p.duration_days, p.quantity, p.refills, p.indication, p.pharmacy,
                p.substitution_allowed, p.instructions, p.status, p.created_at, p.issued_at,
                p.cancelled_at, p.cancellation_reason, p.completed_at, p.superseded_at,
                p.supersedes_id,
                COALESCE(p.prescriber_name, u.display_name) AS prescriber_name,
                COALESCE(p.prescriber_registration, u.registration_number) AS prescriber_registration,
                cancelled.display_name AS cancelled_by_name,
                superseded.display_name AS superseded_by_name
           FROM luminary.prescription p
           JOIN luminary.app_user u ON u.id = p.prescriber_id
           LEFT JOIN luminary.app_user cancelled ON cancelled.id = p.cancelled_by
           LEFT JOIN luminary.app_user superseded ON superseded.id = p.superseded_by
          WHERE p.patient_id = $1 AND p.deleted_at IS NULL
          ORDER BY p.issued_at DESC, p.created_at DESC`,
        [patientId],
      ),
      client.query(
        `SELECT c.id, c.patient_id, c.encounter_id, c.name, c.status, c.goals,
                c.interventions, c.progress, c.next_review, c.created_at,
                u.display_name AS created_by_name
           FROM luminary.care_plan c
           JOIN luminary.app_user u ON u.id = c.created_by
          WHERE c.patient_id = $1 AND c.deleted_at IS NULL
          ORDER BY c.created_at DESC`,
        [patientId],
      ),
      client.query(
        `SELECT r.id, r.patient_id, r.encounter_id, r.referred_to, r.specialty,
                r.reason, r.urgency, r.status, r.notes, r.sent_at, r.completed_at,
                r.created_at, u.display_name AS created_by_name
           FROM luminary.referral r
           JOIN luminary.app_user u ON u.id = r.created_by
          WHERE r.patient_id = $1 AND r.deleted_at IS NULL
          ORDER BY r.created_at DESC`,
        [patientId],
      ),
    ]);
    return {
      labs: labs.rows.map((row) => ({ ...row, tone: toneForLab(row.abnormal) })),
      prescriptions: prescriptions.rows,
      carePlans: carePlans.rows,
      referrals: referrals.rows,
    };
  },

  async createLabResult(
    client: PoolClient,
    actor: Actor,
    input: {
      patientId: string; encounterId?: string | null; orderId?: string | null;
      testName: string; value?: string; unit?: string; normalRange?: string;
      abnormal?: boolean; resultedOn?: string;
    },
  ) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot add clinical results');
    await requirePatientInTenant(client, input.patientId);
    let encounterId = input.encounterId ?? null;

    if (input.orderId) {
      const order = await catalogueRepository.findOrder(client, input.orderId);
      if (!order) throw new NotFound('Order not found');
      if (order.patient_id !== input.patientId) throw new BadRequest('That order does not belong to this patient');
      if (['Cancelled', 'Declined'].includes(String(order.status))) {
        throw new Conflict('A stopped order cannot receive a result');
      }
      if (encounterId && order.encounter_id && encounterId !== order.encounter_id) {
        throw new BadRequest('That result encounter does not match the order encounter');
      }
      encounterId = encounterId ?? order.encounter_id ?? null;
    }

    if (encounterId) {
      const encounter = await requireEncounterInTenant(client, encounterId);
      assertSamePatient(encounter.patient_id, input.patientId, 'That encounter does not belong to this patient');
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.lab_result
         (practice_id, patient_id, encounter_id, order_id, test_name, value, unit, normal_range, abnormal, resulted_on)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.patientId,
        encounterId,
        input.orderId ?? null,
        input.testName.trim(),
        input.value?.trim() || null,
        input.unit?.trim() || null,
        input.normalRange?.trim() || null,
        input.abnormal === true,
        input.resultedOn || null,
      ],
    );

    if (input.orderId) {
      await catalogueService.advanceOrder(client, actor, { id: input.orderId, status: 'Completed' });
    }

    await client.query(
      `SELECT luminary.write_audit('Added clinical result', 'patient', $1, $2, $3, 'notice')`,
      [input.patientId, input.testName.trim(), input.value?.trim() ?? null],
    );
    return rows[0];
  },

  async reviewLabResult(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot review clinical results');
    const { rows } = await client.query(
      `UPDATE luminary.lab_result
          SET reviewed_by = $2, reviewed_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, actor.userId],
    );
    if (!rows[0]) throw new NotFound('Result not found');
    await client.query(
      `SELECT luminary.write_audit('Reviewed clinical result', 'lab_result', $1, $2, NULL, 'notice')`,
      [id, rows[0].test_name],
    );
    return rows[0];
  },

  async createCarePlan(
    client: PoolClient,
    actor: Actor,
    input: { patientId: string; encounterId?: string | null; name: string; goals?: string[]; interventions?: string[]; nextReview?: string },
  ) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot create care plans');
    await requirePatientInTenant(client, input.patientId);
    if (input.encounterId) {
      const encounter = await requireEncounterInTenant(client, input.encounterId);
      assertSamePatient(encounter.patient_id, input.patientId, 'That encounter does not belong to this patient');
    }
    const { rows } = await client.query(
      `INSERT INTO luminary.care_plan
         (practice_id, patient_id, encounter_id, name, goals, interventions, next_review, created_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.patientId,
        input.encounterId ?? null,
        input.name.trim(),
        JSON.stringify(input.goals ?? []),
        JSON.stringify(input.interventions ?? []),
        input.nextReview || null,
        actor.userId,
      ],
    );
    await client.query(
      `SELECT luminary.write_audit('Created care plan', 'patient', $1, $2, $3, 'notice')`,
      [input.patientId, input.name.trim(), input.nextReview ?? null],
    );
    return rows[0];
  },

  async updateCarePlan(
    client: PoolClient,
    actor: Actor,
    id: string,
    input: { status?: string; progress?: number; goals?: string[]; interventions?: string[]; nextReview?: string | null },
  ) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot update care plans');
    const assignments: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (input.status !== undefined) set('status', input.status);
    if (input.progress !== undefined) set('progress', input.progress);
    if (input.goals !== undefined) set('goals', JSON.stringify(input.goals));
    if (input.interventions !== undefined) set('interventions', JSON.stringify(input.interventions));
    if (input.nextReview !== undefined) set('next_review', input.nextReview);
    if (assignments.length === 0) throw new BadRequest('Nothing to update');

    const { rows } = await client.query(
      `UPDATE luminary.care_plan SET ${assignments.join(', ')}, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!rows[0]) throw new NotFound('Care plan not found');
    return rows[0];
  },

  async createReferral(
    client: PoolClient,
    actor: Actor,
    input: { patientId: string; encounterId?: string | null; referredTo: string; specialty?: string; reason: string; urgency?: string; notes?: string },
  ) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot create referrals');
    await requirePatientInTenant(client, input.patientId);
    if (input.encounterId) {
      const encounter = await requireEncounterInTenant(client, input.encounterId);
      assertSamePatient(encounter.patient_id, input.patientId, 'That encounter does not belong to this patient');
    }
    const { rows } = await client.query(
      `INSERT INTO luminary.referral
         (practice_id, patient_id, encounter_id, referred_to, specialty, reason, urgency, notes, created_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.patientId,
        input.encounterId ?? null,
        input.referredTo.trim(),
        input.specialty?.trim() || null,
        input.reason.trim(),
        input.urgency ?? 'routine',
        input.notes?.trim() || null,
        actor.userId,
      ],
    );
    await client.query(
      `SELECT luminary.write_audit('Created referral', 'patient', $1, $2, $3, 'notice')`,
      [input.patientId, input.referredTo.trim(), input.reason.trim().slice(0, 80)],
    );
    return rows[0];
  },

  async updateReferral(client: PoolClient, actor: Actor, id: string, status: string) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot update referrals');
    const { rows } = await client.query(
      `UPDATE luminary.referral
          SET status = $2,
              sent_at = CASE WHEN $2 = 'sent' AND sent_at IS NULL THEN now() ELSE sent_at END,
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, status],
    );
    if (!rows[0]) throw new NotFound('Referral not found');
    return rows[0];
  },

  async uploadDocument(
    client: PoolClient,
    actor: Actor,
    input: {
      patientId: string;
      encounterId?: string | null;
      kind?: string;
      filename: string;
      contentType: string;
      byteSize: number;
      dataBase64: string;
      notes?: string;
    },
  ) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot upload clinical documents');
    if (!input.filename.trim()) throw new BadRequest('A document needs a filename');
    if (!ALLOWED_DOCUMENT_TYPES.has(input.contentType)) {
      throw new BadRequest('Upload a PDF, JPEG, PNG, WebP, or DICOM file');
    }
    if (!Number.isInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > MAX_DOCUMENT_BYTES) {
      throw new BadRequest('Clinical documents must be between 1 byte and 25 MB');
    }

    const data = Buffer.from(input.dataBase64, 'base64');
    if (data.length !== input.byteSize) {
      throw new BadRequest('The uploaded file size did not match the request');
    }

    const patient = await requirePatientInTenant(client, input.patientId);

    if (input.encounterId) {
      const encounter = await requireEncounterInTenant(client, input.encounterId);
      assertSamePatient(encounter.patient_id, input.patientId, 'That encounter does not belong to this patient');
    }

    const stored = await storePatientFile({
      practiceId: actor.practiceId,
      patientId: input.patientId,
      originalName: input.filename,
      bytes: data,
    });

    try {
      const { rows } = await client.query(
        `INSERT INTO luminary.patient_document
           (practice_id, patient_id, encounter_id, uploaded_by, kind, filename,
            content_type, byte_size, storage_key, checksum, notes)
         VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, patient_id, encounter_id, kind, filename, content_type,
                   byte_size, checksum, notes, created_at`,
        [
          input.patientId,
          input.encounterId ?? null,
          actor.userId,
          input.kind?.trim() || 'document',
          input.filename.trim(),
          input.contentType,
          input.byteSize,
          stored.storageKey,
          stored.checksum,
          input.notes?.trim() || null,
        ],
      );
      await client.query(
        `SELECT luminary.write_audit('Uploaded clinical document', 'patient', $1, $2, $3, 'notice')`,
        [input.patientId, patient.full_name, `${input.kind ?? 'document'}: ${input.filename}`],
      );
      return rows[0];
    } catch (error) {
      try {
        await removePatientFile(stored.storageKey);
      } catch (cleanupError) {
        console.error('Failed to clean up newly stored patient document after database failure', {
          storageKey: stored.storageKey,
          error: cleanupError,
        });
      }
      throw error;
    }
  },

  async documentForDownload(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'viewClinicalNotes')) {
      throw new Forbidden('Your role does not include clinical documents');
    }
    const { rows } = await client.query(
      `SELECT id, filename, content_type, byte_size, storage_key
         FROM luminary.patient_document
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const doc = rows[0];
    if (!doc) throw new NotFound('Document not found');
    try {
      return { ...doc, stream: await patientFileStream(doc.storage_key) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        throw new Conflict('Document bytes are not available on this node');
      }
      throw error;
    }
  },

  async archiveDocument(client: PoolClient, actor: Actor, id: string, reason?: string) {
    if (!can(actor.role, 'writeNote')) {
      throw new Forbidden('Your role cannot archive clinical documents');
    }
    const trimmedReason = reason?.trim() || null;
    if (trimmedReason && trimmedReason.length > 240) {
      throw new BadRequest('Archive reason must be 240 characters or fewer');
    }

    const { rows } = await client.query(
      `UPDATE luminary.patient_document
          SET deleted_at = now(), updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, patient_id, encounter_id, kind, filename, content_type,
                  byte_size, checksum, notes, created_at, deleted_at`,
      [id],
    );
    const doc = rows[0];
    if (!doc) throw new NotFound('Document not found');

    await client.query(
      `SELECT luminary.write_audit('Archived clinical document', 'patient', $1, $2, $3, 'notice')`,
      [doc.patient_id, doc.filename, trimmedReason],
    );
    return doc;
  },

  async createDraft(
    client: PoolClient,
    actor: Actor,
    input: { patientId: string; appointmentId?: string | null; noteType?: string },
  ) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot write clinical notes');

    const { rows: patients } = await client.query<{ id: string; merged_into_id: string | null }>(
      `SELECT id, merged_into_id
         FROM luminary.patient
        WHERE id = $1
          AND practice_id = luminary.current_practice_id()
          AND deleted_at IS NULL`,
      [input.patientId],
    );
    if (!patients[0]) throw new NotFound('Patient not found');
    if (patients[0].merged_into_id) {
      throw new BadRequest('This patient has been merged; open the canonical patient record');
    }

    if (input.appointmentId) {
      const { rows: appointments } = await client.query<{ patient_id: string }>(
        `SELECT patient_id
           FROM luminary.appointment
          WHERE id = $1
            AND practice_id = luminary.current_practice_id()
            AND deleted_at IS NULL`,
        [input.appointmentId],
      );
      if (!appointments[0]) throw new NotFound('Appointment not found');
      if (appointments[0].patient_id !== input.patientId) {
        throw new BadRequest('The selected appointment does not belong to this patient');
      }
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.encounter (practice_id, patient_id, appointment_id, author_id, note_type)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4)
       RETURNING *`,
      [input.patientId, input.appointmentId ?? null, actor.userId, input.noteType ?? 'SOAP note'],
    );
    const isTriage = String(rows[0].note_type ?? '').toLowerCase().includes('triage');
    await recordContributor(client, rows[0].id, actor.userId, isTriage ? 'triage' : 'clinical_note');
    if (isTriage && input.appointmentId) {
      await client.query(
        `UPDATE luminary.appointment
            SET status = 'in_triage'
          WHERE id = $1
            AND deleted_at IS NULL
            AND status = 'checked_in'`,
        [input.appointmentId],
      );
      await client.query(
        `SELECT luminary.write_audit('Triage started', 'appointment', $1, $2, $3, 'notice')`,
        [input.appointmentId, rows[0].note_type, rows[0].id],
      );
    }
    await client.query(
      `SELECT luminary.write_audit('Created clinical draft', 'encounter', $1, $2, $3, 'notice')`,
      [rows[0].id, rows[0].note_type, input.appointmentId ? `appointment: ${input.appointmentId}` : null],
    );
    return rows[0];
  },

  /** Vitals are usually a nurse's contribution to a doctor's note. */
  async recordVitals(client: PoolClient, actor: Actor, id: string, vitals: Record<string, unknown>) {
    if (!can(actor.role, 'recordVitals')) throw new Forbidden('Your role cannot record vitals');

    const { rows } = await client.query(
      `UPDATE luminary.encounter SET vitals = $2, vitals_by = $3
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, JSON.stringify(vitals), actor.userId],
    );
    if (!rows[0]) throw new NotFound('Note not found');
    await recordContributor(client, id, actor.userId, 'vitals');
    await client.query(
      `SELECT luminary.write_audit('Recorded encounter vitals', 'encounter', $1, $2, $3, 'notice')`,
      [id, rows[0].note_type, Object.keys(vitals).sort().join(', ') || null],
    );
    return rows[0];
  },

  async saveDraft(client: PoolClient, actor: Actor, id: string, input: Record<string, unknown>) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot write clinical notes');

    const editable = [
      'note_type', 'subjective', 'objective', 'assessment', 'plan', 'follow_up',
      'follow_up_required', 'follow_up_scheduled_for', 'diagnoses',
    ];
    const supplied = Object.keys(input).filter((k) => editable.includes(k));
    if (supplied.length === 0) throw new BadRequest('Nothing to save');

    const assignments = supplied.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = supplied.map((k) => (k === 'diagnoses' ? JSON.stringify(input[k]) : input[k]));

    // The trigger refuses this if the note is signed; that error is translated
    // to a 409 telling the caller to write an addendum instead.
    const { rows } = await client.query(
      `UPDATE luminary.encounter SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, ...values],
    );
    if (!rows[0]) throw new NotFound('Note not found');
    const noteType = String(rows[0].note_type ?? '').toLowerCase();
    const clinicalFields = supplied.filter((field) => field !== 'diagnoses');
    if (clinicalFields.length > 0) {
      await recordContributor(
        client,
        id,
        actor.userId,
        noteType.includes('triage') && supplied.every((field) => ['subjective', 'note_type'].includes(field))
          ? 'triage'
          : 'clinical_note',
      );
    }
    if (supplied.includes('diagnoses')) {
      await recordContributor(client, id, actor.userId, 'diagnosis');
    }
    await client.query(
      `SELECT luminary.write_audit('Saved clinical draft', 'encounter', $1, $2, $3, 'notice')`,
      [id, rows[0].note_type, supplied.sort().join(', ')],
    );
    return rows[0];
  },

  async completeTriage(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'writeNote')) throw new Forbidden('Your role cannot complete triage');

    const { rows: existing } = await client.query(
      `SELECT id, note_type, appointment_id, status
         FROM luminary.encounter
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const note = existing[0];
    if (!note) throw new NotFound('Note not found');
    if (note.status !== 'draft') throw new Conflict('Triage cannot be changed after the note is signed');
    if (!note.appointment_id) throw new BadRequest('Triage completion requires a linked visit');

    const { rows } = await client.query(
      `UPDATE luminary.encounter
          SET triage_completed_at = COALESCE(triage_completed_at, now()),
              triage_completed_by = COALESCE(triage_completed_by, $2)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, actor.userId],
    );
    await recordContributor(client, id, actor.userId, 'triage');
    await client.query(
      `UPDATE luminary.appointment
          SET status = 'waiting_for_provider'
        WHERE id = $1
          AND deleted_at IS NULL
          AND status IN ('checked_in', 'in_triage')`,
      [note.appointment_id],
    );
    await client.query(
      `SELECT luminary.write_audit('Triage completed', 'encounter', $1, $2, $3, 'notice')`,
      [id, note.note_type, `appointment: ${note.appointment_id}`],
    );
    await client.query(
      `SELECT luminary.write_audit('Patient ready for provider', 'appointment', $1, $2, $3, 'notice')`,
      [note.appointment_id, note.note_type, id],
    );
    return rows[0];
  },

  /**
   * Sign. A signature asserts the note is complete, so completeness is checked
   * rather than assumed, and the signer is taken from the session — never from
   * the request body.
   */
  async sign(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'signNote')) {
      throw new Forbidden('Only a prescribing clinician can sign a note');
    }
    if (actor.registrationLapsed) {
      throw new Forbidden('Your practising registration has lapsed — you cannot sign notes until it is renewed');
    }

    const { rows: existing } = await client.query(
      `SELECT * FROM luminary.encounter WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    const note = existing[0];
    if (!note) throw new NotFound('Note not found');
    if (note.status !== 'draft') throw new Conflict('That note is already signed');

    const missing = REQUIRED_TO_SIGN.filter((f) => !String(note[f] ?? '').trim());
    if (missing.length > 0) {
      throw new BadRequest(`Complete the note before signing — missing: ${missing.join(', ')}`);
    }
    if (!Array.isArray(note.diagnoses) || note.diagnoses.length === 0) {
      throw new BadRequest('At least one diagnosis code is required before signing');
    }

    const { rows } = await client.query(
      `UPDATE luminary.encounter
          SET status = 'signed', signed_by = $2, signed_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, actor.userId],
    );
    await recordContributor(client, id, actor.userId, 'signing');
    await client.query(
      `SELECT luminary.write_audit('Signed clinical note', 'encounter', $1, $2, NULL, 'notice')`,
      [id, note.note_type],
    );
    await followupService.ensureIfEligible(client, id);
    return rows[0];
  },

  /** The only legitimate change to a signed note. */
  async addAddendum(client: PoolClient, actor: Actor, id: string, body: string) {
    if (!can(actor.role, 'amendNote')) throw new Forbidden('Your role cannot amend signed notes');
    if (body.trim().length < 10) throw new BadRequest('An addendum needs more detail than that');

    const { rows: existing } = await client.query(
      `SELECT status FROM luminary.encounter WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!existing[0]) throw new NotFound('Note not found');
    if (existing[0].status === 'draft') {
      throw new Conflict('This note is still a draft — edit it directly rather than appending');
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.encounter_addendum (practice_id, encounter_id, body, author_id)
       VALUES (luminary.current_practice_id(), $1, $2, $3)
       RETURNING *`,
      [id, body.trim(), actor.userId],
    );
    await client.query(
      `UPDATE luminary.encounter SET status = 'amended' WHERE id = $1`, [id],
    );
    await followupService.ensureIfEligible(client, id);
    await client.query(
      `SELECT luminary.write_audit('Added addendum', 'encounter', $1, NULL, $2, 'notice')`,
      [id, body.trim().slice(0, 80)],
    );
    return rows[0];
  },

  async prescribe(
    client: PoolClient,
    actor: Actor,
    input: { patientId: string; encounterId?: string | null; drug: string; form?: string; strength?: string;
             dose?: string; route?: string; frequency?: string; durationDays?: number; quantity?: number;
             refills?: number; indication?: string; pharmacy?: string; substitutionAllowed?: boolean;
             instructions?: string; allergiesReviewed?: boolean; supersedesId?: string;
             idempotencyKey?: string },
  ) {
    if (!can(actor.role, 'prescribe')) throw new Forbidden('Your role cannot prescribe');
    if (actor.registrationLapsed) {
      throw new Forbidden('Your practising registration has lapsed — you cannot prescribe until it is renewed');
    }

    if (input.encounterId) {
      const encounter = await requireEncounterInTenant(client, input.encounterId);
      assertSamePatient(encounter.patient_id, input.patientId, 'That encounter does not belong to this patient');
    }

    if (input.idempotencyKey) {
      const { rows: existing } = await client.query(
        `SELECT * FROM luminary.prescription
          WHERE idempotency_key = $1 AND deleted_at IS NULL`,
        [input.idempotencyKey],
      );
      if (existing[0]) {
        if (existing[0].patient_id !== input.patientId || existing[0].prescriber_id !== actor.userId) {
          throw new Conflict('That prescription idempotency key has already been used');
        }
        return existing[0];
      }
    }

    if (input.supersedesId) {
      const { rows: prior } = await client.query(
        `SELECT id, patient_id, status FROM luminary.prescription
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [input.supersedesId],
      );
      if (!prior[0]) throw new NotFound('Prescription to replace not found');
      assertSamePatient(prior[0].patient_id, input.patientId, 'Replacement prescription belongs to another patient');
      if (prior[0].status !== 'active') throw new Conflict('Only an active prescription can be replaced');
    }

    // Allergy checking is a safety control, so it refuses rather than warns.
    const { rows: patient } = await client.query(
      `SELECT full_name, allergies, allergies_reviewed FROM luminary.patient WHERE id = $1`,
      [input.patientId],
    );
    if (!patient[0]) throw new NotFound('Patient not found');

    const allergies: string[] = patient[0].allergies ?? [];
    if (patient[0].allergies_reviewed !== true && input.allergiesReviewed !== true) {
      throw new Conflict('Review and acknowledge this patient\'s allergies before prescribing', {
        code: 'ALLERGY_REVIEW_REQUIRED',
        allergiesReviewed: false,
      });
    }

    const clash = allergies.find((a) =>
      a.toLowerCase().split(/[^a-z]+/).filter(Boolean)
        .some((word) => word.length > 3 && input.drug.toLowerCase().includes(word)),
    );
    if (clash) {
      throw new Conflict(`${patient[0].full_name} has a recorded allergy: "${clash}". Prescribing ${input.drug} is blocked.`);
    }

    if (patient[0].allergies_reviewed !== true && input.allergiesReviewed === true) {
      await client.query(
        `UPDATE luminary.patient SET allergies_reviewed = true, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [input.patientId],
      );
      await client.query(
        `SELECT luminary.write_audit('Reviewed allergies before prescribing', 'patient', $1, $2, $3, 'notice')`,
        [input.patientId, patient[0].full_name, input.drug],
      );
    }

    const { rows: prescriber } = await client.query(
      `SELECT display_name, registration_number FROM luminary.app_user WHERE id = $1`,
      [actor.userId],
    );

    const { rows } = await client.query(
      `INSERT INTO luminary.prescription
         (practice_id, patient_id, encounter_id, prescriber_id, drug, form, strength, dose, route,
          frequency, duration_days, quantity, refills, indication, pharmacy, substitution_allowed,
          instructions, issued_at, prescriber_name, prescriber_registration, supersedes_id, idempotency_key)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, now(), $17, $18, $19, $20)
       ON CONFLICT (practice_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [input.patientId, input.encounterId ?? null, actor.userId, input.drug, input.form ?? null,
       input.strength ?? null, input.dose ?? null, input.route ?? null, input.frequency ?? null,
       input.durationDays ?? null, input.quantity ?? null, input.refills ?? 0, input.indication ?? null,
       input.pharmacy ?? null, input.substitutionAllowed ?? null, input.instructions ?? null,
       prescriber[0]?.display_name ?? null, prescriber[0]?.registration_number ?? null,
       input.supersedesId ?? null, input.idempotencyKey ?? null],
    );

    // A concurrent retry may have won the unique-key race after the earlier
    // lookup. Return that command's result instead of issuing twice or leaking
    // a database uniqueness error to the clinician.
    if (!rows[0] && input.idempotencyKey) {
      const duplicate = await client.query(
        `SELECT * FROM luminary.prescription
          WHERE idempotency_key = $1 AND deleted_at IS NULL`,
        [input.idempotencyKey],
      );
      if (duplicate.rows[0]?.patient_id === input.patientId
          && duplicate.rows[0]?.prescriber_id === actor.userId) {
        return duplicate.rows[0];
      }
      throw new Conflict('That prescription idempotency key has already been used');
    }

    if (input.supersedesId) {
      const replaced = await client.query(
        `UPDATE luminary.prescription
            SET status = 'superseded', superseded_at = now(), superseded_by = $2, updated_at = now()
          WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
          RETURNING id`,
        [input.supersedesId, actor.userId],
      );
      if (replaced.rowCount !== 1) throw new Conflict('The original prescription is no longer active');
      await client.query(
        `SELECT luminary.write_audit('Superseded prescription', 'prescription', $1, $2, $3, 'notice')`,
        [input.supersedesId, input.drug, rows[0].id],
      );
    }
    await client.query(
      `SELECT luminary.write_audit('Issued prescription', 'prescription', $1, $2, $3, 'notice')`,
      [rows[0].id, patient[0].full_name, `${input.drug} ${input.strength ?? ''}`.trim()],
    );
    return rows[0];
  },

  async cancelPrescription(client: PoolClient, actor: Actor, id: string, reason: string) {
    if (!can(actor.role, 'prescribe')) throw new Forbidden('Your role cannot cancel prescriptions');
    const { rows } = await client.query(
      `UPDATE luminary.prescription
          SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
              cancellation_reason = $3, updated_at = now()
        WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
        RETURNING *`,
      [id, actor.userId, reason.trim()],
    );
    if (!rows[0]) {
      const current = await client.query(
        `SELECT status FROM luminary.prescription WHERE id = $1 AND deleted_at IS NULL`, [id],
      );
      if (!current.rows[0]) throw new NotFound('Prescription not found');
      throw new Conflict(`A ${current.rows[0].status} prescription cannot be cancelled`);
    }
    await client.query(
      `SELECT luminary.write_audit('Cancelled prescription', 'prescription', $1, $2, $3, 'notice')`,
      [id, rows[0].drug, reason.trim()],
    );
    return rows[0];
  },

  async completePrescription(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'prescribe')) throw new Forbidden('Your role cannot complete prescriptions');
    const { rows } = await client.query(
      `UPDATE luminary.prescription
          SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
        RETURNING *`,
      [id],
    );
    if (!rows[0]) {
      const current = await client.query(
        `SELECT status FROM luminary.prescription WHERE id = $1 AND deleted_at IS NULL`, [id],
      );
      if (!current.rows[0]) throw new NotFound('Prescription not found');
      throw new Conflict(`A ${current.rows[0].status} prescription cannot be completed`);
    }
    await client.query(
      `SELECT luminary.write_audit('Completed prescription', 'prescription', $1, $2, NULL, 'notice')`,
      [id, rows[0].drug],
    );
    return rows[0];
  },
};
