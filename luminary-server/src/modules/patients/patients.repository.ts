import type { PoolClient } from 'pg';

/**
 * Patient data access.
 *
 * Note what is absent from every query below: `WHERE practice_id = $n`. That is
 * deliberate and it is safe — row-level security applies it, and the connection
 * cannot reach this code without a tenant context (see `platform/db.ts`).
 *
 * Writing the filter here as well would be harmless but misleading: it would
 * suggest the isolation depends on remembering it. It does not, and it must
 * not, because the frontend proved three times over that remembering is exactly
 * what fails.
 */

export interface PatientRow {
  id: string;
  reference: string;
  full_name: string;
  date_of_birth: string | null;
  national_id?: string | null;
  merged_into_id?: string | null;
  merged_at?: string | null;
  merge_reason?: string | null;
  sex: string | null;
  phone: string | null;
  created_at: string;
  status: string;
  balance: string;
  primary_provider_id: string | null;
  allergies: string[];
  allergies_reviewed: boolean;
  member_number: string | null;
  /** Resolved server-side so the registry is one request, not three. */
  primary_provider_name: string | null;
  scheme_name: string | null;
  last_visit_at: string | null;
  next_visit_at: string | null;
}

export interface DuplicateCandidate {
  id: string;
  reference: string;
  full_name: string;
  date_of_birth: string | null;
  national_id: string | null;
  phone: string | null;
  merged_into_id: string | null;
  canonical_patient_id: string;
}

export interface ProbableDuplicateCandidate extends DuplicateCandidate {
  match_reasons: string[];
}

export const normalizeNationalId = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  return raw.replace(/[\s-]/g, '').toLowerCase() || null;
};

export const normalizeName = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw.replace(/\s+/g, ' ').toLowerCase() : null;
};

export const normalizePhone = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value : '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
};

function patientFromDb<T extends { date_of_birth?: unknown }>(row: T): T & { date_of_birth: string | null } {
  const value = row.date_of_birth;
  if (!value) return { ...row, date_of_birth: null };
  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const dd = String(value.getDate()).padStart(2, '0');
    return { ...row, date_of_birth: `${yyyy}-${mm}-${dd}` };
  }
  return { ...row, date_of_birth: String(value).slice(0, 10) };
}

export const patientsRepository = {
  /**
   * The practice's registry. `scope: 'mine'` narrows to patients the caller has
   * standing grounds to see; searching wider is permitted, but *opening* a chart
   * outside that set goes through break-glass.
   */
  async list(
    client: PoolClient,
    opts: { search?: string; scope?: 'mine' | 'practice'; userId: string; limit?: number },
  ): Promise<PatientRow[]> {
    const params: unknown[] = [];
    const where: string[] = ['p.deleted_at IS NULL', 'p.merged_into_id IS NULL'];

    if (opts.search?.trim()) {
      const term = opts.search.trim();
      params.push(`%${term}%`);
      const likeIndex = params.length;
      const digits = term.replace(/\D/g, '');
      const identity = term.replace(/[\s-]/g, '').toLowerCase();
      const clauses = [
        `p.full_name ILIKE $${likeIndex}`,
        `p.reference ILIKE $${likeIndex}`,
        `p.national_id ILIKE $${likeIndex}`,
        `p.phone ILIKE $${likeIndex}`,
        `p.alt_phone ILIKE $${likeIndex}`,
        `p.emergency_phone ILIKE $${likeIndex}`,
        `EXISTS (
          SELECT 1 FROM luminary.patient_identity_alias a
           WHERE a.patient_id = p.id
             AND a.deleted_at IS NULL
             AND a.alias_value ILIKE $${likeIndex}
        )`,
      ];
      if (identity.length >= 4) {
        params.push(`%${identity}%`);
        clauses.push(`lower(regexp_replace(coalesce(p.national_id, ''), '[\\s-]', '', 'g')) LIKE $${params.length}`);
        clauses.push(`EXISTS (
          SELECT 1 FROM luminary.patient_identity_alias a
           WHERE a.patient_id = p.id
             AND a.deleted_at IS NULL
             AND a.normalized_value LIKE $${params.length}
        )`);
      }
      if (digits.length >= 4) {
        params.push(`%${digits}%`);
        clauses.push(`regexp_replace(coalesce(p.phone, ''), '\\D', '', 'g') LIKE $${params.length}`);
        clauses.push(`regexp_replace(coalesce(p.alt_phone, ''), '\\D', '', 'g') LIKE $${params.length}`);
        clauses.push(`regexp_replace(coalesce(p.emergency_phone, ''), '\\D', '', 'g') LIKE $${params.length}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    if (opts.scope === 'mine') {
      params.push(opts.userId);
      where.push(`luminary.care_relationship($${params.length}, p.id) IS NOT NULL`);
    }
    params.push(opts.limit ?? 100);

    const { rows } = await client.query<PatientRow>(
      `SELECT p.id, p.reference, p.full_name, p.date_of_birth, p.sex, p.national_id,
              p.created_at, p.phone, p.merged_into_id, p.merged_at, p.merge_reason,
              p.status, p.balance, p.primary_provider_id, p.allergies,
              p.allergies_reviewed, p.member_number,
              u.display_name AS primary_provider_name,
              s.name         AS scheme_name,
              last_visit.starts_at AS last_visit_at,
              next_visit.starts_at AS next_visit_at
         FROM luminary.patient p
         LEFT JOIN luminary.app_user u ON u.id = p.primary_provider_id
         LEFT JOIN luminary.scheme   s ON s.id = p.scheme_id
         LEFT JOIN LATERAL (
           SELECT a.starts_at FROM luminary.appointment a
            WHERE a.patient_id = p.id AND a.deleted_at IS NULL
              AND a.starts_at < now() AND a.status <> 'cancelled'
            ORDER BY a.starts_at DESC LIMIT 1
         ) last_visit ON true
         LEFT JOIN LATERAL (
           SELECT a.starts_at FROM luminary.appointment a
            WHERE a.patient_id = p.id AND a.deleted_at IS NULL
              AND a.starts_at >= now() AND a.status <> 'cancelled'
            ORDER BY a.starts_at ASC LIMIT 1
         ) next_visit ON true
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(patientFromDb);
  },

  /** Returns null for a patient in another practice — RLS makes them invisible. */
  async findById(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.patient WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? patientFromDb(rows[0]) : null;
  },

  /**
   * Records the access and returns the grounds it was permitted on, or null if
   * only break-glass would allow it. The audit entry is written by the database
   * function so it cannot be skipped by a caller who forgets.
   */
  async logAccess(client: PoolClient, patientId: string): Promise<string | null> {
    const { rows } = await client.query<{ log_chart_access: string | null }>(
      `SELECT luminary.log_chart_access($1)`,
      [patientId],
    );
    return rows[0]?.log_chart_access ?? null;
  },

  async create(client: PoolClient, input: Record<string, unknown>) {
    const { rows } = await client.query(
      `INSERT INTO luminary.patient (
         practice_id, reference, full_name, date_of_birth, sex, national_id,
         phone, email, address_city, emergency_name, emergency_relation, emergency_phone,
         scheme_id, member_number, principal_member, dependant_code, cover_effective_from,
         cover_valid_until, cover_status, primary_provider_id, consent_treatment, consent_comms, status
       ) VALUES (
         luminary.current_practice_id(), $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'New'
       )
       RETURNING *`,
      [
        input.reference, input.fullName, input.dateOfBirth, input.sex, cleanOptionalText(input.nationalId),
        input.phone, input.email, input.addressCity,
        input.emergencyName, input.emergencyRelation, input.emergencyPhone,
        input.schemeId, input.memberNumber, input.principalMember, input.dependantCode,
        input.coverEffectiveFrom, input.coverValidUntil, input.coverStatus,
        input.primaryProviderId, input.consentTreatment, input.consentComms,
      ],
    );
    return patientFromDb(rows[0]);
  },

  async schemeExists(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT 1 FROM luminary.scheme WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [id],
    );
    return rows.length > 0;
  },

  async findDuplicateIdentity(client: PoolClient, input: Record<string, unknown>) {
    const nationalId = cleanOptionalText(input.nationalId);
    if (!nationalId) return null;

    const normalized = normalizeNationalId(nationalId);
    const { rows } = await client.query<DuplicateCandidate>(
      `WITH direct AS (
          SELECT p.id, p.reference, p.full_name, p.date_of_birth, p.national_id, p.phone,
                 p.merged_into_id,
                 COALESCE(p.merged_into_id, p.id) AS canonical_patient_id
            FROM luminary.patient p
           WHERE p.deleted_at IS NULL
             AND nullif(trim(p.national_id), '') IS NOT NULL
             AND lower(regexp_replace(p.national_id, '[\\s-]', '', 'g')) = $1
        ), alias AS (
          SELECT p.id, p.reference, p.full_name, p.date_of_birth, p.national_id, p.phone,
                 p.merged_into_id,
                 a.patient_id AS canonical_patient_id
            FROM luminary.patient_identity_alias a
            JOIN luminary.patient p ON p.id = COALESCE(a.source_patient_id, a.patient_id)
           WHERE a.deleted_at IS NULL
             AND a.alias_type = 'national_id'
             AND a.normalized_value = $1
        )
       SELECT * FROM direct
       UNION ALL
       SELECT * FROM alias
        LIMIT 1`,
      [normalized],
    );
    return rows[0] ? patientFromDb(rows[0]) : null;
  },

  async findProbableDuplicates(client: PoolClient, input: Record<string, unknown>): Promise<ProbableDuplicateCandidate[]> {
    const name = normalizeName(input.fullName);
    const dob = typeof input.dateOfBirth === 'string' ? input.dateOfBirth : null;
    const phone = normalizePhone(input.phone);
    if (!name || !dob || !phone) return [];

    const { rows } = await client.query<ProbableDuplicateCandidate>(
      `SELECT id, reference, full_name, date_of_birth, national_id, phone, merged_into_id,
              id AS canonical_patient_id,
              ARRAY['same_name','same_dob','same_phone']::text[] AS match_reasons
         FROM luminary.patient
        WHERE deleted_at IS NULL
          AND merged_into_id IS NULL
          AND lower(regexp_replace(btrim(full_name), '\\s+', ' ', 'g')) = $1
          AND date_of_birth = $2::date
          AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $3
        ORDER BY full_name
        LIMIT 5`,
      [name, dob, phone],
    );
    return rows.map((row) => patientFromDb(row));
  },

  async findActiveByIdForUpdate(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.patient
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [id],
    );
    return rows[0] ? patientFromDb(rows[0]) : null;
  },

  async findKnownNationalIdOwner(client: PoolClient, nationalId: string, exceptPatientId?: string) {
    const normalized = normalizeNationalId(nationalId);
    if (!normalized) return null;
    const params: unknown[] = [normalized];
    const except = exceptPatientId ? `AND p.id <> $${params.push(exceptPatientId)}` : '';
    const { rows } = await client.query<DuplicateCandidate>(
      `SELECT p.id, p.reference, p.full_name, p.date_of_birth, p.national_id, p.phone,
              p.merged_into_id, COALESCE(p.merged_into_id, p.id) AS canonical_patient_id
         FROM luminary.patient p
        WHERE p.deleted_at IS NULL
          AND nullif(trim(p.national_id), '') IS NOT NULL
          AND lower(regexp_replace(p.national_id, '[\\s-]', '', 'g')) = $1
          ${except}
        LIMIT 1`,
      params,
    );
    return rows[0] ? patientFromDb(rows[0]) : null;
  },

  /**
   * Field groups are separately permissioned, so the service decides which
   * columns a caller may touch and passes only those. A doctor updating a
   * clinical history must not be able to smuggle in a change of medical aid.
   */
  async update(client: PoolClient, id: string, columns: Record<string, unknown>) {
    const keys = Object.keys(columns);
    if (keys.length === 0) return this.findById(client, id);

    const assignments = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    const { rows } = await client.query(
      `UPDATE luminary.patient SET ${assignments}
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, ...keys.map((k) => columns[k])],
    );
    return rows[0] ? patientFromDb(rows[0]) : null;
  },
};

function cleanOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (isUnknownPlaceholder(trimmed)) return null;
  return trimmed ? trimmed : null;
}

function isUnknownPlaceholder(value: string): boolean {
  return ['unknown', 'n/a', 'na', 'none', 'not provided', 'not available'].includes(value.toLowerCase());
}
