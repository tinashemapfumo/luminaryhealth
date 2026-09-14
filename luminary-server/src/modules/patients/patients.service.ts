import type { PoolClient } from 'pg';
import { normalizeNationalId, patientsRepository, type ProbableDuplicateCandidate } from './patients.repository.js';
import { can, type Role } from '../../platform/permissions.js';
import { Forbidden, NotFound, BreakGlassRequired, Conflict, BadRequest } from '../../platform/errors.js';

/**
 * Patient business rules.
 *
 * The rule that matters most here is how a chart is opened. Access is
 * permissive about *reading* and strict about *accountability* — the model real
 * clinical systems use, because a system that flatly refuses the covering
 * doctor, the locum, or the emergency at 2am is one that eventually gets
 * someone hurt.
 *
 * So: no standing relationship does not mean "no". It means "state why, and
 * everyone will see that you looked".
 */

export interface Actor {
  userId: string;
  role: Role;
  practiceId: string;
}

export const patientsService = {
  async list(client: PoolClient, actor: Actor, opts: { search?: string; scope?: 'mine' | 'practice' }) {
    if (!can(actor.role, 'viewPatientDirectory')) {
      throw new Forbidden('Your role does not include patient access');
    }
    // Doctors default to their own list; everyone else works practice-wide,
    // because a nurse serves every doctor and reception books for all of them.
    const scope = opts.scope ?? (actor.role === 'doctor' ? 'mine' : 'practice');
    return patientsRepository.list(client, { ...opts, scope, userId: actor.userId });
  },

  /**
   * Open a chart.
   *
   * Cross-tenant access never reaches here — RLS has already made the row
   * invisible, so it surfaces as NotFound rather than Forbidden. That is
   * deliberate: telling a stranger that a patient exists elsewhere is itself a
   * disclosure.
   */
  async open(client: PoolClient, actor: Actor, patientId: string, breakGlassReason?: string) {
    if (!can(actor.role, 'viewPatientDirectory')) {
      throw new Forbidden('Your role does not include patient access');
    }

    const patient = await patientsRepository.findById(client, patientId);
    if (!patient) throw new NotFound('Patient not found');

    // Writes the audit entry and returns the grounds, or null.
    const relationship = await patientsRepository.logAccess(client, patientId);

    if (relationship) {
      return { patient, relationship, breakGlass: false };
    }

    if (!breakGlassReason || breakGlassReason.trim().length < 10) {
      throw new BreakGlassRequired(
        'You have no care relationship with this patient. Provide a reason to proceed.',
        { patientId, patientName: patient.full_name, provider: patient.primary_provider_id },
      );
    }

    // An exception, not a transfer: expires at end of day and is logged loudly.
    await client.query(
      `INSERT INTO luminary.access_grant
         (practice_id, user_id, patient_id, kind, reason, granted_by, valid_until)
       VALUES (luminary.current_practice_id(), $1, $2, 'break_glass', $3, $1,
               date_trunc('day', now()) + interval '1 day' - interval '1 second')`,
      [actor.userId, patientId, breakGlassReason.trim()],
    );
    await client.query(
      `SELECT luminary.write_audit('Break-glass access', 'patient', $1, $2, $3, 'alert')`,
      [patientId, patient.full_name, breakGlassReason.trim()],
    );

    return { patient, relationship: 'break_glass', breakGlass: true };
  },

  async create(client: PoolClient, actor: Actor, input: Record<string, unknown>) {
    if (!can(actor.role, 'addPatient')) throw new Forbidden('Your role cannot register patients');
    if (!input.consentTreatment) {
      throw new Forbidden('Consent to treatment must be recorded before registration');
    }
    await assertCover(client, input);
    const duplicate = await patientsRepository.findDuplicateIdentity(client, input);
    if (duplicate) {
      throw new Conflict('A patient with this national ID already exists', {
        kind: 'exact_duplicate',
        patientId: duplicate.id,
        canonicalPatientId: duplicate.canonical_patient_id ?? duplicate.id,
        reference: duplicate.reference,
        fullName: duplicate.full_name,
        dateOfBirth: duplicate.date_of_birth,
      });
    }
    const probableDuplicates = await patientsRepository.findProbableDuplicates(client, input);
    if (probableDuplicates.length > 0 && input.duplicateAcknowledged !== true) {
      throw new Conflict('This registration resembles an existing patient', {
        kind: 'probable_duplicate',
        candidates: probableDuplicates.map(publicDuplicateCandidate),
      });
    }
    const patient = await patientsRepository.create(client, input);
    await client.query(
      `SELECT luminary.write_audit('Registered patient', 'patient', $1, $2, NULL, 'notice')`,
      [patient.id, patient.full_name],
    );
    if (probableDuplicates.length > 0) {
      await client.query(
        `SELECT luminary.write_audit('Acknowledged probable duplicate on registration', 'patient', $1, $2, $3, 'alert')`,
        [patient.id, patient.full_name, JSON.stringify(probableDuplicates.map((p) => p.id))],
      );
    }
    return patient;
  },

  async correctIdentity(
    client: PoolClient,
    actor: Actor,
    patientId: string,
    input: { nationalId?: string | null; dateOfBirth?: string | null; reason: string },
  ) {
    if (!can(actor.role, 'manageCover') && !can(actor.role, 'reviewAudit')) {
      throw new Forbidden('Your role cannot correct strong patient identity fields');
    }
    const reason = input.reason.trim();
    const patient = await patientsRepository.findActiveByIdForUpdate(client, patientId);
    if (!patient) throw new NotFound('Patient not found');
    if (patient.merged_into_id) {
      throw new Conflict('This patient has been merged; correct the canonical patient instead', {
        canonicalPatientId: patient.merged_into_id,
      });
    }

    const changes: Record<string, unknown> = {};
    const auditChanges: string[] = [];

    if (Object.prototype.hasOwnProperty.call(input, 'nationalId')) {
      const nextNationalId = normalizeNullableText(input.nationalId);
      if (nextNationalId) {
        const owner = await patientsRepository.findKnownNationalIdOwner(client, nextNationalId, patientId);
        if (owner) {
          throw new Conflict('Another patient already has this national ID', {
            kind: 'exact_duplicate',
            patientId: owner.id,
            canonicalPatientId: owner.canonical_patient_id ?? owner.id,
            reference: owner.reference,
            fullName: owner.full_name,
            dateOfBirth: owner.date_of_birth,
          });
        }
      }
      if (nextNationalId !== (patient.national_id ?? null)) {
        changes.national_id = nextNationalId;
        auditChanges.push(`national_id:${maskIdentity(patient.national_id)}->${maskIdentity(nextNationalId)}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, 'dateOfBirth')) {
      const nextDob = normalizeNullableText(input.dateOfBirth);
      if (nextDob !== (patient.date_of_birth ?? null)) {
        changes.date_of_birth = nextDob;
        auditChanges.push(`date_of_birth:${patient.date_of_birth ?? 'unknown'}->${nextDob ?? 'unknown'}`);
      }
    }

    if (Object.keys(changes).length === 0) return patient;
    const updated = await patientsRepository.update(client, patientId, changes);
    if (!updated) throw new NotFound('Patient not found');
    await client.query(
      `SELECT luminary.write_audit('Corrected patient identity', 'patient', $1, $2, $3, 'alert')`,
      [patientId, updated.full_name, `${auditChanges.join('; ')} | reason: ${reason}`],
    );
    return updated;
  },

  async merge(
    client: PoolClient,
    actor: Actor,
    input: { sourcePatientId: string; survivorPatientId: string; reason: string },
  ) {
    if (!can(actor.role, 'manageCover') && !can(actor.role, 'reviewAudit')) {
      throw new Forbidden('Your role cannot merge patient identities');
    }
    if (input.sourcePatientId === input.survivorPatientId) {
      throw new BadRequest('Source and survivor must be different patients');
    }
    const reason = input.reason.trim();

    const { rows: locked } = await client.query(
      `SELECT * FROM luminary.patient
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
        ORDER BY id
        FOR UPDATE`,
      [[input.sourcePatientId, input.survivorPatientId]],
    );
    const source = locked.find((row) => row.id === input.sourcePatientId);
    const survivor = locked.find((row) => row.id === input.survivorPatientId);
    if (!source || !survivor) throw new NotFound('Patient not found');
    if (source.merged_into_id === survivor.id) {
      return {
        status: 'already_merged',
        sourcePatientId: source.id,
        survivorPatientId: survivor.id,
        mergedAt: source.merged_at,
      };
    }
    if (source.merged_into_id) {
      throw new Conflict('Source patient has already been merged', {
        canonicalPatientId: source.merged_into_id,
      });
    }
    if (survivor.merged_into_id) {
      throw new Conflict('Survivor patient is not canonical', {
        canonicalPatientId: survivor.merged_into_id,
      });
    }

    const sourceNational = normalizeNullableText(source.national_id);
    const survivorNational = normalizeNullableText(survivor.national_id);
    if (sourceNational && survivorNational
        && normalizeNationalId(sourceNational) !== normalizeNationalId(survivorNational)) {
      throw new Conflict('Patients have different known national IDs; correct identity before merging');
    }

    const activeGrantCount = await countRows(client, 'access_grant', source.id, 'AND deleted_at IS NULL');
    if (activeGrantCount > 0) {
      throw new Conflict('Source patient has active access grants; revoke or expire them before merge');
    }

    const before = await countPatientLinks(client, [source.id, survivor.id]);
    const adoptedNationalId = !survivorNational && sourceNational ? sourceNational : null;
    if (adoptedNationalId) {
      await patientsRepository.update(client, source.id, { national_id: null });
      await patientsRepository.update(client, survivor.id, { national_id: adoptedNationalId });
    }

    const moved: Record<string, number> = {};
    for (const table of MERGE_PATIENT_TABLES) {
      moved[table] = await movePatientLinks(client, table, source.id, survivor.id);
    }

    await client.query(
      `INSERT INTO luminary.patient_identity_alias
         (practice_id, patient_id, source_patient_id, alias_type, alias_value, normalized_value, created_by, reason)
       VALUES
         (luminary.current_practice_id(), $1, $2, 'reference', $3, lower($3), $4, $5)
       ON CONFLICT (practice_id, alias_type, normalized_value) DO NOTHING`,
      [survivor.id, source.id, source.reference, actor.userId, reason],
    );
    if (sourceNational) {
      await client.query(
        `INSERT INTO luminary.patient_identity_alias
           (practice_id, patient_id, source_patient_id, alias_type, alias_value, normalized_value, created_by, reason)
         VALUES
           (luminary.current_practice_id(), $1, $2, 'national_id', $3, $4, $5, $6)
         ON CONFLICT (practice_id, alias_type, normalized_value) DO NOTHING`,
        [survivor.id, source.id, sourceNational, normalizeNationalId(sourceNational), actor.userId, reason],
      );
    }

    const { rows } = await client.query(
      `UPDATE luminary.patient
          SET merged_into_id = $2, merged_at = now(), merged_by = $3,
              merge_reason = $4, updated_at = now()
        WHERE id = $1 AND merged_into_id IS NULL
        RETURNING *`,
      [source.id, survivor.id, actor.userId, reason],
    );
    if (rows.length === 0) throw new Conflict('Source patient was merged by another request');

    const after = await countPatientLinks(client, [survivor.id]);
    await client.query(
      `SELECT luminary.write_audit('Merged patient identity', 'patient', $1, $2, $3, 'alert')`,
      [survivor.id, survivor.full_name, JSON.stringify({
        sourcePatientId: source.id,
        survivorPatientId: survivor.id,
        reason,
        adoptedNationalId: Boolean(adoptedNationalId),
        moved,
      })],
    );

    return {
      status: 'merged',
      sourcePatientId: source.id,
      survivorPatientId: survivor.id,
      reason,
      adoptedNationalId: Boolean(adoptedNationalId),
      moved,
      before,
      after,
    };
  },

  /**
   * Update, permissioned by field group rather than wholesale. Demographics,
   * cover, and clinical history are separate grants: reception maintains
   * contact details, a clinician maintains allergies, and neither should be
   * able to change the other by posting a wider body than they are entitled to.
   */
  async update(client: PoolClient, actor: Actor, patientId: string, input: Record<string, unknown>) {
    const normalized = normalizePatientPatch(input);
    await assertCover(client, normalized);

    const groups: Record<string, { permission: Parameters<typeof can>[1]; columns: string[] }> = {
      demographics: {
        permission: 'editDemographics',
        columns: ['full_name', 'preferred_name', 'phone', 'alt_phone', 'email',
                  'address_street', 'address_suburb', 'address_city', 'preferred_contact',
                  'emergency_name', 'emergency_relation', 'emergency_phone',
                  'marital_status', 'occupation', 'language', 'consent_comms'],
      },
      cover: {
        permission: 'editCover',
        columns: ['scheme_id', 'member_number', 'principal_member', 'dependant_code',
                  'cover_effective_from', 'cover_valid_until', 'cover_status',
                  'member_suffix', 'relationship_to_member', 'cover_external_ref',
                  'cover_verified_at', 'cover_verification_status'],
      },
      clinical: {
        permission: 'editClinicalHistory',
        columns: ['blood_type', 'allergies', 'allergies_reviewed', 'conditions', 'medications',
                  'family_history', 'immunisations', 'smoking', 'alcohol', 'exercise',
                  'risk', 'clinical_summary'],
      },
    };

    const permitted: Record<string, unknown> = {};
    const refused: string[] = [];

    for (const [column, value] of Object.entries(normalized)) {
      const group = Object.values(groups).find((g) => g.columns.includes(column));
      if (!group) continue;                       // unknown column: ignore silently
      if (can(actor.role, group.permission)) permitted[column] = value;
      else refused.push(column);
    }

    if (refused.length > 0) {
      throw new Forbidden(`Your role cannot change: ${refused.join(', ')}`);
    }
    if (Object.keys(permitted).length === 0) throw new Forbidden('Nothing you may change was supplied');

    const before = Object.prototype.hasOwnProperty.call(permitted, 'consent_comms')
      ? await patientsRepository.findActiveByIdForUpdate(client, patientId)
      : null;
    const updated = await patientsRepository.update(client, patientId, permitted);
    if (!updated) throw new NotFound('Patient not found');

    await client.query(
      `SELECT luminary.write_audit('Updated patient record', 'patient', $1, $2, $3, 'notice')`,
      [patientId, updated.full_name, Object.keys(permitted).join(', ')],
    );
    if (before && before.consentComms !== updated.consentComms) {
      await client.query(
        `SELECT luminary.write_audit('Changed communication consent', 'patient', $1, $2, $3, 'alert')`,
        [
          patientId,
          updated.full_name,
          `${before.consentComms ? 'true' : 'false'} -> ${updated.consentComms ? 'true' : 'false'}`,
        ],
      );
    }
    return updated;
  },
};

const MERGE_PATIENT_TABLES = [
  'agent_conversation',
  'appointment',
  'care_plan',
  'claim_eligibility_result',
  'claim_authorisation',
  'encounter',
  'clinical_order',
  'invoice',
  'claim',
  'collection_case',
  'inbound_message',
  'intake_proposal',
  'lab_result',
  'message',
  'patient_document',
  'prescription',
  'referral',
] as const;

const PATIENT_PATCH_COLUMNS: Record<string, string> = {
  fullName: 'full_name',
  preferredName: 'preferred_name',
  dateOfBirth: 'date_of_birth',
  altPhone: 'alt_phone',
  addressStreet: 'address_street',
  addressSuburb: 'address_suburb',
  addressCity: 'address_city',
  addressCountry: 'address_country',
  preferredContact: 'preferred_contact',
  emergencyName: 'emergency_name',
  emergencyRelation: 'emergency_relation',
  emergencyPhone: 'emergency_phone',
  schemeId: 'scheme_id',
  memberNumber: 'member_number',
  principalMember: 'principal_member',
  dependantCode: 'dependant_code',
  coverEffectiveFrom: 'cover_effective_from',
  coverValidUntil: 'cover_valid_until',
  coverStatus: 'cover_status',
  memberSuffix: 'member_suffix',
  relationshipToMember: 'relationship_to_member',
  coverExternalRef: 'cover_external_ref',
  coverVerifiedAt: 'cover_verified_at',
  coverVerificationStatus: 'cover_verification_status',
  bloodType: 'blood_type',
  allergiesReviewed: 'allergies_reviewed',
  familyHistory: 'family_history',
  clinicalSummary: 'clinical_summary',
  consentTreatment: 'consent_treatment',
  consentComms: 'consent_comms',
  consentDataSharing: 'consent_data_sharing',
};

function normalizePatientPatch(input: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[PATIENT_PATCH_COLUMNS[key] ?? key] = value;
  }
  return normalized;
}

async function assertCover(client: PoolClient, input: Record<string, unknown>) {
  if (input.cover_effective_from && input.cover_valid_until
      && String(input.cover_effective_from) > String(input.cover_valid_until)) {
    throw new BadRequest('Cover start date cannot be after cover expiry');
  }
  if (input.scheme_id) {
    const exists = await patientsRepository.schemeExists(client, String(input.scheme_id));
    if (!exists) throw new NotFound('Scheme not found');
  }
}

function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (['unknown', 'n/a', 'na', 'none', 'not provided', 'not available'].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed ? trimmed : null;
}

function maskIdentity(value: unknown): string {
  const text = normalizeNullableText(value);
  if (!text) return 'unknown';
  if (text.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
}

function publicDuplicateCandidate(candidate: ProbableDuplicateCandidate) {
  return {
    patientId: candidate.id,
    canonicalPatientId: candidate.canonical_patient_id,
    reference: candidate.reference,
    fullName: candidate.full_name,
    dateOfBirth: candidate.date_of_birth,
    phone: maskPhone(candidate.phone),
    nationalIdKnown: Boolean(candidate.national_id),
    matchReasons: candidate.match_reasons,
  };
}

function maskPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

async function movePatientLinks(client: PoolClient, table: string, sourceId: string, survivorId: string): Promise<number> {
  const result = await client.query(
    `UPDATE luminary.${table}
        SET patient_id = $2, updated_at = now()
      WHERE patient_id = $1`,
    [sourceId, survivorId],
  );
  return result.rowCount ?? 0;
}

async function countRows(client: PoolClient, table: string, patientId: string, extra = ''): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM luminary.${table} WHERE patient_id = $1 ${extra}`,
    [patientId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function countPatientLinks(client: PoolClient, patientIds: string[]) {
  const counts: Record<string, Record<string, number>> = {};
  for (const patientId of patientIds) {
    counts[patientId] = {};
    for (const table of MERGE_PATIENT_TABLES) {
      counts[patientId][table] = await countRows(client, table, patientId);
    }
  }
  return counts;
}
