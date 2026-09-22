import type { PoolClient } from 'pg';
import { normalizeName, normalizeNationalId, normalizePhone } from '../patients/patients.repository.js';

export type PatientMatchResult =
  | { result: 'matched'; patientId: string }
  | { result: 'no_match' | 'ambiguous' | 'insufficient_evidence' };

export interface PatientMatchInput {
  fullName?: string;
  dateOfBirth?: string;
  phone?: string;
  nationalId?: string | null;
}

/**
 * Patient identity resolution for untrusted agent input.
 *
 * Only an exact strong identity or a unique phone + DOB + full-name match may
 * bind automatically. Contradictory or shared evidence never becomes a guess.
 */
export const patientMatchingService = {
  async match(client: PoolClient, input: PatientMatchInput): Promise<PatientMatchResult> {
    const nationalId = normalizeNationalId(input.nationalId);
    const fullName = normalizeName(input.fullName);
    const dateOfBirth = input.dateOfBirth ?? null;
    const phone = normalizePhone(input.phone);

    if (nationalId) {
      const { rows } = await client.query<{ id: string; full_name: string; date_of_birth: string | null }>(
        `WITH candidates AS (
           SELECT COALESCE(p.merged_into_id, p.id) AS id
             FROM luminary.patient p
            WHERE p.deleted_at IS NULL
              AND lower(regexp_replace(coalesce(p.national_id, ''), '[\\s-]', '', 'g')) = $1
           UNION
           SELECT a.patient_id
             FROM luminary.patient_identity_alias a
            WHERE a.deleted_at IS NULL
              AND a.alias_type = 'national_id'
              AND a.normalized_value = $1
         )
         SELECT p.id, p.full_name, p.date_of_birth
           FROM (SELECT DISTINCT id FROM candidates LIMIT 2) c
           JOIN luminary.patient p ON p.id = c.id`,
        [nationalId],
      );
      if (rows.length === 1) {
        if (!fullName || !dateOfBirth) return { result: 'insufficient_evidence' };
        const candidate = rows[0]!;
        const sameName = normalizeName(candidate.full_name) === fullName;
        const sameDob = String(candidate.date_of_birth ?? '').slice(0, 10) === dateOfBirth;
        return sameName && sameDob
          ? { result: 'matched', patientId: candidate.id }
          : { result: 'ambiguous' };
      }
      if (rows.length > 1) return { result: 'ambiguous' };
    }

    if (!fullName || !dateOfBirth || !phone) return { result: 'insufficient_evidence' };

    const { rows: phoneRows } = await client.query<{
      id: string; full_name: string; date_of_birth: string | null;
    }>(
      `SELECT id, full_name, date_of_birth
         FROM luminary.patient
        WHERE deleted_at IS NULL AND merged_into_id IS NULL
          AND (
            regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $1
            OR regexp_replace(coalesce(alt_phone, ''), '\\D', '', 'g') = $1
          )
        LIMIT 3`,
      [phone],
    );

    if (phoneRows.length > 1) return { result: 'ambiguous' };
    if (phoneRows.length === 1) {
      const candidate = phoneRows[0]!;
      const sameName = normalizeName(candidate.full_name) === fullName;
      const sameDob = String(candidate.date_of_birth ?? '').slice(0, 10) === dateOfBirth;
      return sameName && sameDob
        ? { result: 'matched', patientId: candidate.id }
        : { result: 'ambiguous' };
    }

    const { rows: identityRows } = await client.query<{ id: string }>(
      `SELECT id FROM luminary.patient
        WHERE deleted_at IS NULL AND merged_into_id IS NULL
          AND lower(regexp_replace(btrim(full_name), '\\s+', ' ', 'g')) = $1
          AND date_of_birth = $2::date
        LIMIT 2`,
      [fullName, dateOfBirth],
    );
    if (identityRows.length > 0) return { result: 'ambiguous' };
    return { result: 'no_match' };
  },
};
