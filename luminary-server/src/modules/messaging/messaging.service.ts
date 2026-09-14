import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { can, type Role } from '../../platform/permissions.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';

/**
 * Patient messaging.
 *
 * Delivery is delegated to an n8n workflow rather than a carrier SDK. That is a
 * deliberate seam: SMS providers in this market change, differ between
 * practices, and are exactly the sort of thing a clinic's own IT person should
 * be able to rewire without waiting for a release.
 *
 * Two properties matter more than the transport:
 *
 * **Recording intent is separate from sending.** A message is written to the
 * database first and dispatched afterwards. When the line is down the queue
 * simply grows and drains later — the same property that makes the local server
 * worth running — and nothing is lost, because sending was never what recorded
 * the intent.
 *
 * **Consent is checked at send time, not at template time.** A patient who has
 * withdrawn consent to reminders must stop receiving them immediately, without
 * anyone remembering to prune a campaign.
 */

export interface Actor {
  userId: string;
  role: Role;
  practiceId: string;
}

const CHANNELS = ['sms', 'whatsapp', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Clinical messages a patient cannot opt out of, versus marketing-shaped ones. */
const CONSENT_EXEMPT = new Set(['appointment_confirmation', 'clinical_result', 'account_statement']);

export const messagingService = {
  async list(client: PoolClient, actor: Actor, opts: { patientId?: string; status?: string }) {
    if (!can(actor.role, 'sendMessages')) throw new Forbidden('Your role does not include messaging');

    const params: unknown[] = [];
    const where = ['m.deleted_at IS NULL'];
    if (opts.patientId) { params.push(opts.patientId); where.push(`m.patient_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); where.push(`m.status = $${params.length}`); }

    const { rows } = await client.query(
      `SELECT m.id, m.channel, m.template, m.body, m.status, m.recipient,
              m.appointment_id, m.queued_at, m.sent_at, m.delivered_at, m.failed_at,
              m.attempts, m.last_error, m.provider_ref,
              p.full_name AS patient_name, u.display_name AS sent_by_name
         FROM luminary.message m
         LEFT JOIN luminary.patient p ON p.id = m.patient_id
         LEFT JOIN luminary.app_user u ON u.id = m.sent_by
        WHERE ${where.join(' AND ')}
        ORDER BY m.queued_at DESC
        LIMIT 200`,
      params,
    );
    return rows;
  },

  /**
   * Queue a message. Never sends inline — a slow carrier must not hold a
   * clinician's request open, and a failed send must not lose the intent.
   */
  /**
   * Queue a message on behalf of a workflow rather than a person.
   *
   * Separate from `queue` deliberately. That one checks a user's role and takes
   * a patient; this one has no user, and may legitimately be sent to a number
   * that belongs to nobody on file — an n8n flow confirming an appointment to
   * whoever booked it. Sharing one function would have meant weakening the
   * role check that protects the human path.
   *
   * `sent_by` stays null and `sent_via_credential` records which workflow did
   * it, so "who sent this?" has an answer that is not a missing value.
   */
  async queueFromIntegration(
    client: PoolClient,
    input: {
      patientId?: string; to: string; channel: Channel;
      body: string; template?: string; credentialId: string; appointmentId?: string;
    },
  ) {
    if (!CHANNELS.includes(input.channel)) throw new BadRequest(`Unknown channel: ${input.channel}`);
    if (input.body.trim().length === 0) throw new BadRequest('The message is empty');
    if (input.channel === 'sms' && input.body.length > 480) {
      throw new BadRequest('SMS is limited to 480 characters (three segments)');
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.message
         (practice_id, patient_id, appointment_id, channel, template, body, recipient, status, sent_via_credential)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, 'queued', $7)
       RETURNING *`,
      [
        input.patientId ?? null, input.appointmentId ?? null, input.channel, input.template ?? null,
        input.body.trim(), input.to, input.credentialId,
      ],
    );

    await client.query(
      `SELECT luminary.write_audit('Queued a message via integration', 'message', $1, $2, $3, 'info')`,
      [rows[0].id, input.to, input.channel],
    );

    return rows[0];
  },

  async queue(
    client: PoolClient,
    actor: Actor,
    input: { patientId: string; channel: Channel; body: string; template?: string; appointmentId?: string },
  ) {
    if (!can(actor.role, 'sendMessages')) throw new Forbidden('Your role cannot message patients');
    if (!CHANNELS.includes(input.channel)) throw new BadRequest(`Unknown channel: ${input.channel}`);
    if (input.body.trim().length === 0) throw new BadRequest('The message is empty');
    if (input.channel === 'sms' && input.body.length > 480) {
      throw new BadRequest('SMS is limited to 480 characters (three segments)');
    }

    const { rows: patient } = await client.query(
      `SELECT full_name, phone, email, consent_comms, preferred_contact
         FROM luminary.patient WHERE id = $1 AND deleted_at IS NULL`,
      [input.patientId],
    );
    if (!patient[0]) throw new NotFound('Patient not found');

    const template = input.template ?? 'manual';
    if (!patient[0].consent_comms && !CONSENT_EXEMPT.has(template)) {
      throw new Forbidden(
        `${patient[0].full_name} has not consented to reminders. ` +
        'Clinical results and appointment confirmations may still be sent.',
      );
    }

    const recipient = input.channel === 'email' ? patient[0].email : patient[0].phone;
    if (!recipient) {
      throw new BadRequest(`No ${input.channel === 'email' ? 'email address' : 'phone number'} on file`);
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.message
         (practice_id, patient_id, appointment_id, channel, template, body, recipient, sent_by, status)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, 'queued')
       RETURNING *`,
      [input.patientId, input.appointmentId ?? null, input.channel, template, input.body.trim(), recipient, actor.userId],
    );
    await client.query(
      `SELECT luminary.write_audit('Queued patient message', 'patient', $1, $2, $3, 'info')`,
      [input.patientId, patient[0].full_name, `${input.channel}: ${template}`],
    );
    return rows[0];
  },

  /** Claims a batch for dispatch, so two workers cannot send the same message twice. */
  async claimBatch(client: PoolClient, limit = 25) {
    const { rows } = await client.query(
      `UPDATE luminary.message
          SET status = 'sending', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM luminary.message
           WHERE status = 'queued' AND deleted_at IS NULL
             AND attempts < 5
           ORDER BY queued_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING *`,
      [limit],
    );
    return rows;
  },

  async markSent(client: PoolClient, id: string, providerRef: string | null) {
    await client.query(
      `UPDATE luminary.message SET status = 'sent', sent_at = now(), provider_ref = $2, last_error = NULL
        WHERE id = $1`,
      [id, providerRef],
    );
  },

  async cancelIfConsentWithdrawn(client: PoolClient, id: string): Promise<boolean> {
    const { rows } = await client.query(
      `UPDATE luminary.message m
          SET status = 'cancelled',
              last_error = 'Communication consent withdrawn before dispatch',
              updated_at = now()
         FROM luminary.patient p
        WHERE m.id = $1
          AND m.patient_id = p.id
          AND m.status = 'sending'
          AND m.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND p.consent_comms = false
          AND COALESCE(m.template, 'manual') <> ALL($2::text[])
        RETURNING m.id`,
      [id, Array.from(CONSENT_EXEMPT)],
    );
    return rows.length > 0;
  },

  /**
   * A failed send returns to the queue for another attempt, until the attempt
   * ceiling. Giving up quietly would leave a clinician believing a patient was
   * told something they never were.
   */
  async markFailed(client: PoolClient, id: string, error: string) {
    const { rows } = await client.query(
      `UPDATE luminary.message
          SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
              last_error = $2,
              failed_at = CASE WHEN attempts >= 5 THEN now() ELSE NULL END
        WHERE id = $1
        RETURNING status, attempts`,
      [id, error.slice(0, 500)],
    );
    return rows[0];
  },

  /**
   * Delivery receipt from n8n. Verified by HMAC over the raw body, because this
   * endpoint is necessarily reachable without a session.
   */
  async recordReceipt(
    client: PoolClient,
    input: { messageId: string; status: 'delivered' | 'failed'; providerRef?: string; error?: string },
  ) {
    const { rows } = await client.query(
      `UPDATE luminary.message
          SET status = $2,
              delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
              failed_at = CASE WHEN $2 = 'failed' THEN now() ELSE failed_at END,
              provider_ref = COALESCE($3, provider_ref),
              last_error = COALESCE($4, last_error)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, status`,
      [input.messageId, input.status, input.providerRef ?? null, input.error ?? null],
    );
    if (!rows[0]) throw new NotFound('Message not found');
    return rows[0];
  },

  async cancel(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'sendMessages')) throw new Forbidden('Your role cannot cancel messages');
    const { rows } = await client.query(
      `UPDATE luminary.message SET status = 'cancelled'
        WHERE id = $1 AND status = 'queued' AND deleted_at IS NULL
        RETURNING id`,
      [id],
    );
    if (!rows[0]) throw new Conflict('That message has already left the queue');
    return rows[0];
  },

  async cancelQueuedForAppointment(client: PoolClient, appointmentId: string, reason: string) {
    const { rows } = await client.query(
      `UPDATE luminary.message
          SET status = 'cancelled',
              last_error = $2,
              updated_at = now()
        WHERE appointment_id = $1
          AND practice_id = luminary.current_practice_id()
          AND status = 'queued'
          AND deleted_at IS NULL
        RETURNING id`,
      [appointmentId, reason.slice(0, 500)],
    );
    return rows;
  },

  async operationalStatus(client: PoolClient) {
    const { rows: counts } = await client.query(
      `SELECT status, count(*)::int AS count
         FROM luminary.message
        WHERE deleted_at IS NULL
        GROUP BY status`,
    );
    const config = await messagingService.webhookConfig(client);
    return {
      providerConfigured: Boolean(config?.url),
      counts: Object.fromEntries(counts.map((r) => [r.status, r.count])),
    };
  },

  async webhookConfig(client: PoolClient) {
    const { rows } = await client.query(
      `SELECT messaging_webhook_url AS url, messaging_webhook_secret AS secret, sms_sender_id AS sender
         FROM luminary.practice_settings
        WHERE practice_id = luminary.current_practice_id()`,
    );
    return rows[0] ?? null;
  },
};

/** HMAC-SHA256 over the raw request body — the shared shape n8n can produce. */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(secret: string, body: string, provided: string): boolean {
  const expected = Buffer.from(signPayload(secret, body));
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
