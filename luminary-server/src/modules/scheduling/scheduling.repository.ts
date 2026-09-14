import type { PoolClient } from 'pg';

/**
 * Scheduling data access.
 *
 * Overlap is not checked here. The exclusion constraints on `appointment` refuse
 * a clashing booking in the database, which is the only place that holds when
 * two nodes reconnect after an outage and both believe the slot is free. A
 * check-then-insert in application code has a race the constraint does not.
 */

export const schedulingRepository = {
  async list(
    client: PoolClient,
    opts: { from?: string; to?: string; providerId?: string; roomId?: string; patientId?: string; includeReadyUnassigned?: boolean },
  ) {
    const params: unknown[] = [];
    const where = ['a.practice_id = luminary.current_practice_id()', 'a.deleted_at IS NULL'];
    const operationalTime = 'COALESCE(a.starts_at, a.arrived_at, a.created_at)';

    if (opts.from) {
      params.push(opts.from);
      where.push(/^\d{4}-\d{2}-\d{2}$/.test(opts.from)
        ? `${operationalTime} >= (($${params.length}::date)::timestamp AT TIME ZONE COALESCE((SELECT timezone FROM luminary.practice_settings WHERE practice_id = luminary.current_practice_id()), 'Africa/Harare'))`
        : `${operationalTime} >= $${params.length}`);
    }
    if (opts.to) {
      params.push(opts.to);
      where.push(/^\d{4}-\d{2}-\d{2}$/.test(opts.to)
        ? `${operationalTime} < ((($${params.length}::date + 1)::timestamp) AT TIME ZONE COALESCE((SELECT timezone FROM luminary.practice_settings WHERE practice_id = luminary.current_practice_id()), 'Africa/Harare'))`
        : `${operationalTime} < $${params.length}`);
    }
    if (opts.providerId) {
      params.push(opts.providerId);
      where.push(opts.includeReadyUnassigned
        ? `(a.provider_id = $${params.length} OR (a.provider_id IS NULL AND a.status = 'waiting_for_provider'))`
        : `a.provider_id = $${params.length}`);
    }
    if (opts.roomId) { params.push(opts.roomId); where.push(`a.room_id = $${params.length}`); }
    if (opts.patientId) { params.push(opts.patientId); where.push(`a.patient_id = $${params.length}`); }

    const { rows } = await client.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.duration_min, a.visit_type, a.mode, a.status,
              a.origin, a.arrived_at, a.provider_assigned_at, a.provider_assigned_by,
              a.status_reason,
              p.id AS patient_id, p.full_name AS patient_name, p.reference AS patient_reference,
              -- Surfaced on the day list because a clinician must see it before
              -- prescribing, not after opening the chart.
              p.allergies, p.allergies_reviewed,
              u.id AS provider_id, u.display_name AS provider_name,
              r.name AS room_name
         FROM luminary.appointment a
         JOIN luminary.patient p ON p.id = a.patient_id
         LEFT JOIN luminary.app_user u ON u.id = a.provider_id
         LEFT JOIN luminary.room r ON r.id = a.room_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(a.starts_at, a.arrived_at, a.created_at)`,
      params,
    );
    return rows;
  },

  async findById(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT a.*, p.full_name AS patient_name, u.display_name AS provider_name
         FROM luminary.appointment a
         JOIN luminary.patient p ON p.id = a.patient_id
         LEFT JOIN luminary.app_user u ON u.id = a.provider_id
        WHERE a.id = $1
          AND a.practice_id = luminary.current_practice_id()
          AND a.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  async statusHistory(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT h.id, h.appointment_id, h.from_status, h.to_status, h.reason,
              h.changed_at, h.changed_by, u.display_name AS changed_by_name
         FROM luminary.appointment_status_history h
         LEFT JOIN luminary.app_user u ON u.id = h.changed_by
        WHERE h.appointment_id = $1
          AND h.practice_id = luminary.current_practice_id()
          AND h.deleted_at IS NULL
        ORDER BY h.changed_at, h.created_at`,
      [id],
    );
    return rows;
  },

  async create(
    client: PoolClient,
    input: { patientId: string; providerId?: string | null; roomId?: string | null;
             startsAt?: string | null; durationMin: number; visitType?: string; mode?: string;
             origin?: 'scheduled' | 'walk_in'; reason?: string | null; status?: string; actorId?: string },
  ) {
    const origin = input.origin ?? 'scheduled';
    const visitType = input.visitType ?? input.reason ?? (origin === 'walk_in' ? 'Walk-in' : 'Consultation');
    const { rows } = await client.query(
      `INSERT INTO luminary.appointment
         (practice_id, patient_id, provider_id, room_id, starts_at, duration_min, visit_type, mode,
          origin, arrived_at, status, provider_assigned_at, provider_assigned_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7,
               $8, CASE WHEN $8 = 'walk_in' THEN now() ELSE NULL END, $9,
               CASE WHEN $2::uuid IS NOT NULL THEN now() ELSE NULL END,
               CASE WHEN $2::uuid IS NOT NULL THEN $10::uuid ELSE NULL END)
       RETURNING *`,
      [input.patientId, input.providerId ?? null, input.roomId ?? null, input.startsAt ?? null,
       input.durationMin, visitType, input.mode ?? 'in_person', origin,
       input.status ?? (origin === 'walk_in' ? 'checked_in' : 'booked'), input.actorId ?? null],
    );
    return rows[0];
  },

  async reschedule(
    client: PoolClient,
    id: string,
    input: { startsAt?: string; durationMin?: number; providerId?: string; roomId?: string | null; actorId?: string },
  ) {
    const { rows } = await client.query(
      `UPDATE luminary.appointment
          SET starts_at    = COALESCE($2, starts_at),
              duration_min = COALESCE($3, duration_min),
              provider_id  = COALESCE($4, provider_id),
              room_id      = COALESCE($5, room_id),
              provider_assigned_at = CASE
                WHEN $4::uuid IS NOT NULL AND provider_id IS DISTINCT FROM $4 THEN now()
                ELSE provider_assigned_at
              END,
              provider_assigned_by = CASE
                WHEN $4::uuid IS NOT NULL AND provider_id IS DISTINCT FROM $4 THEN $6::uuid
                ELSE provider_assigned_by
              END
        WHERE id = $1
          AND practice_id = luminary.current_practice_id()
          AND deleted_at IS NULL
        RETURNING *`,
      [id, input.startsAt ?? null, input.durationMin ?? null, input.providerId ?? null,
       input.roomId ?? null, input.actorId ?? null],
    );
    return rows[0] ?? null;
  },

  async setStatus(client: PoolClient, id: string, status: string, reason?: string | null) {
    const { rows } = await client.query(
      `UPDATE luminary.appointment
          SET status = $2,
              arrived_at = CASE
                WHEN $2 = 'checked_in' THEN COALESCE(arrived_at, now())
                ELSE arrived_at
              END,
              status_reason = CASE
                WHEN $2 IN ('cancelled', 'no_show') THEN NULLIF(btrim($3), '')
                WHEN $2 = 'booked' THEN NULL
                ELSE status_reason
              END
        WHERE id = $1
          AND practice_id = luminary.current_practice_id()
          AND deleted_at IS NULL
        RETURNING *`,
      [id, status, reason ?? null],
    );
    return rows[0] ?? null;
  },

  async practiceOpenForScheduledSlot(client: PoolClient, startsAt: string, durationMin: number): Promise<boolean> {
    const { rows } = await client.query(
      `WITH settings AS (
         SELECT opens_at, closes_at, open_days, COALESCE(timezone, 'Africa/Harare') AS timezone
           FROM luminary.practice_settings
          WHERE practice_id = luminary.current_practice_id()
       ),
       slot AS (
         SELECT ($1::timestamptz AT TIME ZONE timezone) AS local_start,
                (($1::timestamptz + make_interval(mins => $2::int)) AT TIME ZONE timezone) AS local_end,
                opens_at, closes_at, open_days
           FROM settings
       )
       SELECT EXISTS (
         SELECT 1
           FROM slot
          WHERE to_char(local_start::date, 'FMDay') = ANY(open_days)
            AND local_start::date = local_end::date
            AND local_start::time >= opens_at
            AND local_end::time <= closes_at
       ) AS open`,
      [startsAt, durationMin],
    );
    return rows[0]?.open === true;
  },

  async completeTriage(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `UPDATE luminary.appointment
          SET status = 'waiting_for_provider'
        WHERE id = $1
          AND practice_id = luminary.current_practice_id()
          AND deleted_at IS NULL
          AND status IN ('checked_in', 'in_triage')
        RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  },

  /**
   * Free slots for a provider on a given day, honouring the practice's opening
   * hours and slot length rather than assumed nine-to-five.
   */
  async providerExists(client: PoolClient, providerId: string): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT 1
        FROM luminary.app_user
        WHERE id = $1
          AND practice_id = luminary.current_practice_id()
          AND active = true
          AND is_provider = true
          AND deleted_at IS NULL`,
      [providerId],
    );
    return rows.length > 0;
  },

  async availability(
    client: PoolClient,
    providerId: string,
    day: string,
    opts: { durationMin?: number; roomId?: string | null } = {},
  ) {
    const { rows } = await client.query(
      `WITH settings AS (
         SELECT opens_at, closes_at, slot_minutes, open_days
           FROM luminary.practice_settings
          WHERE practice_id = luminary.current_practice_id()
       ),
       slots AS (
         SELECT generate_series(
                  ($1::date + (SELECT opens_at FROM settings))::timestamptz,
                  ($1::date + (SELECT closes_at FROM settings))::timestamptz
                    - make_interval(mins => (SELECT slot_minutes FROM settings)),
                  make_interval(mins => (SELECT slot_minutes FROM settings))
                ) AS slot_start
       )
       SELECT s.slot_start,
              NOT EXISTS (
                SELECT 1 FROM luminary.appointment a
                 WHERE a.provider_id = $2
                   AND a.practice_id = luminary.current_practice_id()
                   AND a.deleted_at IS NULL
                   AND a.status <> 'cancelled'
                   AND a.period && tstzrange(
                        s.slot_start,
                        s.slot_start + make_interval(mins => COALESCE($3::int, (SELECT slot_minutes FROM settings))),
                        '[)'
                      )
              ) AS free
         FROM slots s
        WHERE EXISTS (
          SELECT 1
            FROM settings
           WHERE to_char($1::date, 'FMDay') = ANY(open_days)
        )
          AND (
            $4::uuid IS NULL OR NOT EXISTS (
              SELECT 1 FROM luminary.appointment a
               WHERE a.room_id = $4
                 AND a.practice_id = luminary.current_practice_id()
                 AND a.deleted_at IS NULL
                 AND a.status <> 'cancelled'
                 AND a.period && tstzrange(
                      s.slot_start,
                      s.slot_start + make_interval(mins => COALESCE($3::int, (SELECT slot_minutes FROM settings))),
                      '[)'
                    )
            )
          )
        ORDER BY s.slot_start`,
      [day, providerId, opts.durationMin ?? null, opts.roomId ?? null],
    );
    return rows;
  },
};
