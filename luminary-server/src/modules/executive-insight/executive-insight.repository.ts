import type { PoolClient } from 'pg';
import type { DateRange } from './reporting-period.js';

export interface PracticeClock { timezone: string; today: string }
export interface AppointmentStats {
  scheduled: number; completed: number; cancelled: number; noShows: number;
  uniquePatients: number; newPatients: number; activeDays: number;
  averageLeadTimeDays: number | null;
}
export interface MoneyRow { currency: string; billed: number; collected: number; outstanding: number }
export interface ClaimRow {
  currency: string; submitted: number; approved: number; rejected: number; pending: number;
  submittedValue: number; approvedValue: number; rejectedValue: number; pendingValue: number;
  averageProcessingDays: number | null;
}

const dates = (range: DateRange, timezone: string) => [range.from, range.toExclusive, timezone];

export const executiveInsightRepository = {
  async practiceClock(client: PoolClient): Promise<PracticeClock> {
    const { rows } = await client.query<PracticeClock>(
      `SELECT COALESCE(ps.timezone, 'Africa/Harare') AS timezone,
              (now() AT TIME ZONE COALESCE(ps.timezone, 'Africa/Harare'))::date::text AS today
         FROM luminary.practice p
         LEFT JOIN luminary.practice_settings ps ON ps.practice_id = p.id AND ps.deleted_at IS NULL
        WHERE p.id = luminary.current_practice_id()`,
    );
    return rows[0] ?? { timezone: 'Africa/Harare', today: new Date().toISOString().slice(0, 10) };
  },

  async appointments(client: PoolClient, range: DateRange, timezone: string): Promise<AppointmentStats> {
    const { rows } = await client.query(
      `WITH scoped AS (
         SELECT a.*,
                (COALESCE(a.starts_at, a.arrived_at) AT TIME ZONE $3)::date AS activity_date
           FROM luminary.appointment a
          WHERE a.practice_id = luminary.current_practice_id()
            AND a.deleted_at IS NULL
            AND (COALESCE(a.starts_at, a.arrived_at) AT TIME ZONE $3)::date >= $1::date
            AND (COALESCE(a.starts_at, a.arrived_at) AT TIME ZONE $3)::date < $2::date
       )
       SELECT count(*)::int AS scheduled,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
              count(DISTINCT patient_id) FILTER (WHERE status = 'completed')::int AS unique_patients,
              count(DISTINCT patient_id) FILTER (
                WHERE status = 'completed' AND NOT EXISTS (
                  SELECT 1 FROM luminary.appointment prior
                   WHERE prior.practice_id = luminary.current_practice_id()
                     AND prior.patient_id = scoped.patient_id
                     AND prior.status = 'completed' AND prior.deleted_at IS NULL
                     AND COALESCE(prior.starts_at, prior.arrived_at) < COALESCE(scoped.starts_at, scoped.arrived_at)
                ))::int AS new_patients,
              count(DISTINCT activity_date) FILTER (WHERE status = 'completed')::int AS active_days,
              round(avg(EXTRACT(epoch FROM (starts_at - created_at)) / 86400.0)
                FILTER (WHERE origin = 'scheduled' AND starts_at >= created_at), 2)::float8 AS average_lead_time_days
         FROM scoped`, dates(range, timezone));
    const row = rows[0] ?? {};
    return {
      scheduled: Number(row.scheduled ?? 0), completed: Number(row.completed ?? 0),
      cancelled: Number(row.cancelled ?? 0), noShows: Number(row.no_shows ?? 0),
      uniquePatients: Number(row.unique_patients ?? 0), newPatients: Number(row.new_patients ?? 0),
      activeDays: Number(row.active_days ?? 0),
      averageLeadTimeDays: row.average_lead_time_days === null ? null : Number(row.average_lead_time_days),
    };
  },

  async activityExtremes(client: PoolClient, range: DateRange, timezone: string) {
    const { rows } = await client.query<{ date: string; count: number }>(
      `SELECT (COALESCE(starts_at, arrived_at) AT TIME ZONE $3)::date::text AS date, count(*)::int AS count
         FROM luminary.appointment
        WHERE practice_id = luminary.current_practice_id() AND deleted_at IS NULL AND status = 'completed'
          AND (COALESCE(starts_at, arrived_at) AT TIME ZONE $3)::date >= $1::date
          AND (COALESCE(starts_at, arrived_at) AT TIME ZONE $3)::date < $2::date
        GROUP BY 1 ORDER BY count DESC, date ASC`, dates(range, timezone));
    return rows;
  },

  async revenue(client: PoolClient, range: DateRange, timezone: string): Promise<MoneyRow[]> {
    const { rows } = await client.query(
      `WITH currencies AS (
         SELECT currency FROM luminary.invoice
          WHERE practice_id = luminary.current_practice_id() AND deleted_at IS NULL
            AND issued_on >= $1::date AND issued_on < $2::date
         UNION
         SELECT i.currency FROM luminary.payment p JOIN luminary.invoice i ON i.id = p.invoice_id
          WHERE p.practice_id = luminary.current_practice_id() AND p.deleted_at IS NULL
            AND (p.received_at AT TIME ZONE $3)::date >= $1::date
            AND (p.received_at AT TIME ZONE $3)::date < $2::date
       )
       SELECT c.currency,
              COALESCE((SELECT sum(i.total) FROM luminary.invoice i
                         WHERE i.practice_id = luminary.current_practice_id() AND i.deleted_at IS NULL
                           AND i.currency = c.currency AND i.issued_on >= $1::date AND i.issued_on < $2::date), 0)::float8 AS billed,
              COALESCE((SELECT sum(p.amount * COALESCE(p.fx_rate, 1)) FROM luminary.payment p
                         JOIN luminary.invoice i ON i.id = p.invoice_id
                        WHERE p.practice_id = luminary.current_practice_id() AND p.deleted_at IS NULL
                          AND i.currency = c.currency AND (p.received_at AT TIME ZONE $3)::date >= $1::date
                          AND (p.received_at AT TIME ZONE $3)::date < $2::date), 0)::float8 AS collected,
              COALESCE((SELECT sum(GREATEST(i.total - i.amount_paid, 0)) FROM luminary.invoice i
                         WHERE i.practice_id = luminary.current_practice_id() AND i.deleted_at IS NULL
                           AND i.currency = c.currency AND i.issued_on >= $1::date AND i.issued_on < $2::date), 0)::float8 AS outstanding
         FROM currencies c ORDER BY c.currency`, dates(range, timezone));
    return rows.map((row) => ({
      currency: row.currency, billed: Number(row.billed), collected: Number(row.collected),
      outstanding: Number(row.outstanding),
    }));
  },

  async paymentBreakdown(client: PoolClient, range: DateRange, timezone: string) {
    const { rows } = await client.query<{ currency: string; method: string; amount: number }>(
      `SELECT i.currency, lower(p.method) AS method,
              sum(p.amount * COALESCE(p.fx_rate, 1))::float8 AS amount
         FROM luminary.payment p JOIN luminary.invoice i ON i.id = p.invoice_id
        WHERE p.practice_id = luminary.current_practice_id() AND p.deleted_at IS NULL
          AND (p.received_at AT TIME ZONE $3)::date >= $1::date
          AND (p.received_at AT TIME ZONE $3)::date < $2::date
        GROUP BY i.currency, lower(p.method) ORDER BY i.currency, method`, dates(range, timezone));
    return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  },

  async receivables(client: PoolClient, asOf: string) {
    const { rows } = await client.query<{ currency: string; bucket: string; amount: number }>(
      `SELECT currency,
              CASE WHEN $1::date - COALESCE(due_on, issued_on) <= 0 THEN 'current'
                   WHEN $1::date - COALESCE(due_on, issued_on) <= 30 THEN 'over30Days'
                   WHEN $1::date - COALESCE(due_on, issued_on) <= 60 THEN 'over60Days'
                   ELSE 'over90Days' END AS bucket,
              sum(GREATEST(total - amount_paid, 0))::float8 AS amount
         FROM luminary.invoice
        WHERE practice_id = luminary.current_practice_id() AND deleted_at IS NULL
          AND issued_on <= $1::date AND total > amount_paid
        GROUP BY currency, bucket ORDER BY currency, bucket`, [asOf]);
    return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  },

  async claims(client: PoolClient, range: DateRange, timezone: string): Promise<ClaimRow[]> {
    const { rows } = await client.query(
      `SELECT currency,
              count(*)::int AS submitted,
              count(*) FILTER (WHERE status IN ('APPROVED','PARTIALLY_APPROVED'))::int AS approved,
              count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
              count(*) FILTER (WHERE status IN ('SUBMITTING','SUBMITTED','ACKNOWLEDGED','PROCESSING','QUERY','REQUIRES_ACTION'))::int AS pending,
              COALESCE(sum(total_claimed_amount), 0)::float8 AS submitted_value,
              COALESCE(sum(total_approved_amount) FILTER (WHERE status IN ('APPROVED','PARTIALLY_APPROVED')), 0)::float8 AS approved_value,
              COALESCE(sum(total_rejected_amount) FILTER (WHERE status = 'REJECTED'), 0)::float8 AS rejected_value,
              COALESCE(sum(total_claimed_amount) FILTER (WHERE status IN ('SUBMITTING','SUBMITTED','ACKNOWLEDGED','PROCESSING','QUERY','REQUIRES_ACTION')), 0)::float8 AS pending_value,
              round(avg(EXTRACT(epoch FROM (completed_at - submitted_at)) / 86400.0)
                FILTER (WHERE completed_at IS NOT NULL), 2)::float8 AS average_processing_days
         FROM luminary.claim
        WHERE practice_id = luminary.current_practice_id() AND deleted_at IS NULL
          AND submitted_at IS NOT NULL
          AND (submitted_at AT TIME ZONE $3)::date >= $1::date
          AND (submitted_at AT TIME ZONE $3)::date < $2::date
        GROUP BY currency ORDER BY currency`, dates(range, timezone));
    return rows.map((row) => ({
      currency: row.currency, submitted: Number(row.submitted), approved: Number(row.approved),
      rejected: Number(row.rejected), pending: Number(row.pending), submittedValue: Number(row.submitted_value),
      approvedValue: Number(row.approved_value), rejectedValue: Number(row.rejected_value), pendingValue: Number(row.pending_value),
      averageProcessingDays: row.average_processing_days === null ? null : Number(row.average_processing_days),
    }));
  },

  async rejectionCategories(client: PoolClient, range: DateRange, timezone: string) {
    const { rows } = await client.query<{ category: string; count: number }>(
      `SELECT COALESCE(NULLIF(rejection_code, ''), 'unspecified') AS category, count(*)::int AS count
         FROM luminary.claim
        WHERE practice_id = luminary.current_practice_id() AND deleted_at IS NULL AND status = 'REJECTED'
          AND submitted_at IS NOT NULL AND (submitted_at AT TIME ZONE $3)::date >= $1::date
          AND (submitted_at AT TIME ZONE $3)::date < $2::date
        GROUP BY 1 ORDER BY count DESC, category`, dates(range, timezone));
    return rows;
  },

  async operations(client: PoolClient, range: DateRange, timezone: string) {
    const { rows } = await client.query(
      `WITH visits AS (
         SELECT a.id, a.arrived_at,
                min(h.changed_at) FILTER (WHERE h.to_status = 'in_consultation') AS consultation_started_at,
                min(h.changed_at) FILTER (WHERE h.to_status = 'completed') AS completed_at
           FROM luminary.appointment a
           LEFT JOIN luminary.appointment_status_history h
             ON h.appointment_id = a.id AND h.practice_id = luminary.current_practice_id() AND h.deleted_at IS NULL
          WHERE a.practice_id = luminary.current_practice_id() AND a.deleted_at IS NULL AND a.status = 'completed'
            AND (COALESCE(a.starts_at, a.arrived_at) AT TIME ZONE $3)::date >= $1::date
            AND (COALESCE(a.starts_at, a.arrived_at) AT TIME ZONE $3)::date < $2::date
          GROUP BY a.id, a.arrived_at
       )
       SELECT count(*)::int AS patients_processed,
              round(avg(EXTRACT(epoch FROM (consultation_started_at - arrived_at)) / 60.0)
                FILTER (WHERE consultation_started_at >= arrived_at), 2)::float8 AS average_wait_minutes,
              round(avg(EXTRACT(epoch FROM (completed_at - consultation_started_at)) / 60.0)
                FILTER (WHERE completed_at >= consultation_started_at), 2)::float8 AS average_consultation_minutes,
              round(avg(EXTRACT(epoch FROM (completed_at - arrived_at)) / 60.0)
                FILTER (WHERE completed_at >= arrived_at), 2)::float8 AS average_total_visit_minutes,
              count(*) FILTER (WHERE consultation_started_at - arrived_at > interval '30 minutes')::int AS delayed_visits
         FROM visits`, dates(range, timezone));
    const row = rows[0] ?? {};
    return {
      patientsProcessed: Number(row.patients_processed ?? 0),
      averageWaitMinutes: row.average_wait_minutes === null ? null : Number(row.average_wait_minutes),
      averageConsultationMinutes: row.average_consultation_minutes === null ? null : Number(row.average_consultation_minutes),
      averageTotalVisitMinutes: row.average_total_visit_minutes === null ? null : Number(row.average_total_visit_minutes),
      delayedVisits: Number(row.delayed_visits ?? 0),
    };
  },
};
