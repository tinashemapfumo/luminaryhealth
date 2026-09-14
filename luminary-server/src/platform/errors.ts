/**
 * Typed errors mapped to HTTP at the edge, so services never touch a reply.
 *
 * Two deliberate choices about what these say.
 *
 * `NotFound` is used for a row in another practice, not `Forbidden`. Telling a
 * caller "you may not see this patient" confirms the patient exists somewhere,
 * which is itself a disclosure. Row-level security makes the row invisible; the
 * API keeps that story straight.
 *
 * `BreakGlassRequired` is a distinct status because it is not a refusal. The
 * client is being asked for a reason, after which the same request will
 * succeed — a 403 would tell it to give up.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequest extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'bad_request', details);
  }
}

export class Unauthorized extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}

export class Forbidden extends AppError {
  constructor(message: string) {
    super(message, 403, 'forbidden');
  }
}

export class NotFound extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'not_found');
  }
}

export class Conflict extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'conflict', details);
  }
}

/** 428 Precondition Required: supply a reason and retry. */
export class BreakGlassRequired extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 428, 'break_glass_required', details);
  }
}

/**
 * Postgres constraint violations carry meaning the API should translate rather
 * than leak. The exclusion constraints on `appointment` are the load-bearing
 * example: two nodes syncing after an outage will genuinely both try to book
 * the same slot, and the database is what stops them.
 */
export function translatePostgresError(error: unknown): AppError | null {
  const pg = error as { code?: string; constraint?: string; message?: string };
  if (!pg?.code) return null;

  switch (pg.code) {
    case '23P01': // exclusion_violation
      if (pg.constraint === 'appointment_provider_no_overlap') {
        return new Conflict('That provider already has an appointment overlapping this time');
      }
      if (pg.constraint === 'appointment_room_no_overlap') {
        return new Conflict('That room is already occupied at this time');
      }
      return new Conflict('That booking overlaps an existing one');
    case '23505': // unique_violation
      if (pg.constraint === 'patient_national_id_unique_active_idx') {
        return new Conflict('A patient with this national ID already exists');
      }
      return new Conflict('That record already exists');
    case '23503': // foreign_key_violation, including same-practice guard triggers.
      if (pg.constraint === 'encounter_appointment_same_practice') return new NotFound('Appointment not found');
      if (pg.constraint === 'encounter_patient_same_practice') return new NotFound('Patient not found');
      if (pg.constraint?.includes('patient')) return new NotFound('Patient not found');
      if (pg.constraint?.includes('invoice')) return new NotFound('Invoice not found');
      if (pg.constraint?.includes('claim')) return new NotFound('Claim not found');
      if (pg.constraint?.includes('remittance')) return new NotFound('Remittance not found');
      if (pg.constraint?.includes('payer')) return new NotFound('Payer not found');
      if (pg.constraint?.includes('service')) return new NotFound('Service not found');
      if (pg.constraint?.includes('order')) return new NotFound('Order not found');
      if (pg.constraint?.includes('encounter')) return new NotFound('Encounter not found');
      if (pg.constraint?.includes('tariff')) return new NotFound('Tariff not found');
      return new NotFound('Referenced record not found');
    case '23514': // check_violation
      if (pg.constraint === 'encounter_appointment_patient_match') {
        return new BadRequest('The selected appointment does not belong to this patient');
      }
      if (pg.constraint === 'encounter_patient_canonical') {
        return new BadRequest('This patient has been merged; open the canonical patient record');
      }
      if (pg.constraint === 'grant_reason_present') {
        return new BadRequest('A fuller reason is required');
      }
      if (pg.constraint?.startsWith('invoice_line_')) {
        return new BadRequest(pg.message ?? 'Invoice line references are not valid');
      }
      if (pg.constraint?.startsWith('payment_')
        || pg.constraint?.startsWith('claim_remittance_')
        || pg.constraint?.startsWith('invoice_adjustment_')
        || pg.constraint?.startsWith('claim_denial_')) {
        return new BadRequest(pg.message ?? 'Financial references are not valid');
      }
      if (pg.constraint === 'signature_consistent') {
        return new BadRequest('A signed note must carry a signature');
      }
      return new BadRequest('That value is not permitted');
    case '23001': // restrict_violation — raised by the immutability trigger.
      // Postgres reports this as 23001, not 2F004 (which is
      // reading_sql_data_not_permitted). Getting it wrong turned a helpful
      // 409 into an unhandled 500: the record stayed protected, but the caller
      // was told nothing useful.
      return new Conflict(
        pg.message?.includes('signed')
          ? 'This note is signed; record a correction as an addendum'
          : 'That change is not permitted',
      );
    case '42501': // insufficient_privilege, e.g. an attempt to alter the audit trail
      return new Forbidden('That operation is not permitted');
    default:
      return null;
  }
}
