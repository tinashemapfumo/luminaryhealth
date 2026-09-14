import type { PoolClient } from 'pg';
import { can } from '../../platform/permissions.js';
import { BadRequest, Forbidden, NotFound } from '../../platform/errors.js';
import { mintCredential, integrationSigningKey, INTEGRATION_SCOPES } from '../../platform/integration.js';
import type { Actor } from '../billing/billing.service.js';
import { numberKey } from '../../platform/phone.js';
import { requirePatientInTenant } from '../../platform/tenant-refs.js';

/**
 * The n8n side of messaging.
 *
 * Outbound has always worked — the dispatcher posts queued messages to the
 * practice's configured webhook, signed. This is the return path: a patient
 * replying, and the carrier reporting what happened to what we sent.
 *
 * Everything here is written to be called repeatedly with the same payload.
 * Carriers and workflow engines redeliver on timeout, and a webhook that is not
 * idempotent turns one slow response into a duplicate conversation — or, worse,
 * a second copy of a patient's message in their record.
 */

export const integrationsService = {
  // --- credentials ---------------------------------------------------------

  async listCredentials(client: PoolClient, actor: Actor) {
    if (!can(actor.role, 'manageIntegrations')) {
      throw new Forbidden('Only an administrator manages integration credentials');
    }
    const { rows } = await client.query(
      `SELECT id, name, key_id, scopes, active, last_used_at, expires_at, created_at
         FROM luminary.integration_credential
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC`,
    );
    return rows;
  },

  /**
   * Issue a credential.
   *
   * The signing key is returned exactly once. It is not recoverable afterwards
   * — only its hash is stored — so a practice that mislays it rotates rather
   * than asks. Saying that plainly at the point of issue is the difference
   * between a rotation and a support call.
   */
  async createCredential(
    client: PoolClient,
    actor: Actor,
    input: { name: string; scopes: string[]; expiresAt?: string | null },
  ) {
    if (!can(actor.role, 'manageIntegrations')) {
      throw new Forbidden('Only an administrator issues integration credentials');
    }
    const unknown = input.scopes.filter((s) => !INTEGRATION_SCOPES.includes(s as never));
    if (unknown.length > 0) throw new BadRequest(`Unknown scope: ${unknown.join(', ')}`);
    if (input.scopes.length === 0) throw new BadRequest('A credential with no scopes can do nothing');

    const { keyId, secret, secretHash } = mintCredential();
    const { rows } = await client.query(
      `INSERT INTO luminary.integration_credential
         (practice_id, name, key_id, secret_hash, scopes, expires_at, created_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6)
       RETURNING id, name, key_id, scopes, active, expires_at, created_at`,
      [input.name, keyId, secretHash, input.scopes, input.expiresAt ?? null, actor.userId],
    );

    await client.query(
      `SELECT luminary.write_audit('Issued an integration credential', 'integration', $1, $2, $3, 'alert')`,
      [rows[0].id, input.name, input.scopes.join(', ')],
    );

    return {
      ...rows[0],
      // Shown once. The workflow signs with this, never with the raw secret.
      signingKey: integrationSigningKey(secret),
      warning: 'Copy the signing key now — it is stored only as a hash and cannot be shown again.',
    };
  },

  async revokeCredential(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'manageIntegrations')) {
      throw new Forbidden('Only an administrator revokes integration credentials');
    }
    const { rows } = await client.query(
      `UPDATE luminary.integration_credential
          SET active = false, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name`,
      [id],
    );
    if (!rows[0]) throw new NotFound('Credential not found');

    await client.query(
      `SELECT luminary.write_audit('Revoked an integration credential', 'integration', $1, $2, $3, 'alert')`,
      [rows[0].id, rows[0].name, 'revoked'],
    );
    return rows[0];
  },

  // --- inbound -------------------------------------------------------------

  /**
   * Record a message a patient sent us.
   *
   * Idempotent on the carrier's own reference: a redelivery returns the row
   * that already exists rather than creating a second one. The patient is
   * matched by number, and **left unattached when nothing matches** — guessing
   * would file one person's medical conversation in another's record, which is
   * a worse outcome than a message someone has to triage by hand.
   */
  async recordInbound(
    client: PoolClient,
    input: {
      channel: string; from: string; body: string; providerRef: string;
      mediaUrl?: string | null; receivedAt?: string | null; raw?: unknown;
    },
  ) {
    const key = numberKey(input.from);
    const { rows: patients } = key.length >= 9
      ? await client.query(
        `SELECT id, full_name FROM luminary.patient
          WHERE deleted_at IS NULL
            AND (right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = $1
              OR right(regexp_replace(coalesce(alt_phone, ''), '\\D', '', 'g'), 9) = $1)
          LIMIT 2`,
        [key],
      )
      : { rows: [] };

    // Two patients on one number is a household sharing a handset, and picking
    // either is a coin toss with someone's chart. Left unattached for a person.
    const patient = patients.length === 1 ? patients[0] : null;

    const { rows } = await client.query(
      `INSERT INTO luminary.inbound_message
         (practice_id, patient_id, channel, from_number, body, media_url, provider_ref, received_at, raw)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8)
       ON CONFLICT (practice_id, provider_ref) DO NOTHING
       RETURNING *`,
      [
        patient?.id ?? null, input.channel, input.from, input.body,
        input.mediaUrl ?? null, input.providerRef, input.receivedAt ?? null,
        JSON.stringify(input.raw ?? {}),
      ],
    );

    if (rows.length === 0) {
      const { rows: existing } = await client.query(
        `SELECT * FROM luminary.inbound_message
          WHERE practice_id = luminary.current_practice_id() AND provider_ref = $1`,
        [input.providerRef],
      );
      return { message: existing[0], duplicate: true, matchedPatient: null };
    }

    // Notice severity: an unmatched inbound message is a clinical
    // communication nobody is currently responsible for.
    await client.query(
      `SELECT luminary.write_audit('Received a patient message', 'inbound_message', $1, $2, $3, $4)`,
      [
        rows[0].id,
        patient?.full_name ?? input.from,
        patient ? 'matched to a patient' : 'no patient matched this number',
        patient ? 'info' : 'notice',
      ],
    );

    return { message: rows[0], duplicate: false, matchedPatient: patient ?? null };
  },

  /**
   * Record what the carrier says happened to a message we sent.
   *
   * Statuses only ever move forward. Carriers deliver out of order — a `read`
   * can arrive before its `delivered` — and letting a late arrival walk a
   * message backwards would report a delivered reminder as merely sent.
   */
  async recordReceipt(
    client: PoolClient,
    input: { messageId?: string; providerRef?: string; status: string; detail?: string; occurredAt?: string },
  ) {
    const { rows: found } = input.messageId
      ? await client.query(
        `SELECT * FROM luminary.message WHERE id = $1 AND deleted_at IS NULL`,
        [input.messageId],
      )
      : await client.query(
        `SELECT * FROM luminary.message
          WHERE provider_ref = $1 AND deleted_at IS NULL
          ORDER BY queued_at DESC LIMIT 1`,
        [input.providerRef],
      );

    const message = found[0];
    if (!message) throw new NotFound('No message matches that reference');

    await client.query(
      `INSERT INTO luminary.message_receipt
         (practice_id, message_id, status, detail, provider_ref, occurred_at)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, COALESCE($5::timestamptz, now()))
       ON CONFLICT (practice_id, message_id, status) DO NOTHING`,
      [message.id, input.status, input.detail ?? null, input.providerRef ?? null, input.occurredAt ?? null],
    );

    const RANK: Record<string, number> = {
      queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5, cancelled: 5,
    };
    const forward = (RANK[input.status] ?? 0) > (RANK[message.status] ?? 0);

    const { rows: updated } = await client.query(
      `UPDATE luminary.message
          SET status       = CASE WHEN $2 THEN $3 ELSE status END,
              delivered_at = CASE WHEN $3 = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
              read_at      = CASE WHEN $3 = 'read'      THEN COALESCE(read_at, now())      ELSE read_at END,
              failed_at    = CASE WHEN $3 = 'failed'    THEN COALESCE(failed_at, now())    ELSE failed_at END,
              last_error   = CASE WHEN $3 = 'failed'    THEN $4 ELSE last_error END,
              updated_at   = now()
        WHERE id = $1
        RETURNING *`,
      [message.id, forward, input.status, input.detail ?? null],
    );

    return { message: updated[0], applied: forward };
  },

  // --- reading -------------------------------------------------------------

  async listInbound(client: PoolClient, actor: Actor, opts: { unhandledOnly?: boolean; patientId?: string }) {
    if (!can(actor.role, 'sendMessages')) {
      throw new Forbidden('Your role does not include patient messaging');
    }
    const { rows } = await client.query(
      `SELECT m.*, p.full_name AS patient_name
         FROM luminary.inbound_message m
         LEFT JOIN luminary.patient p ON p.id = m.patient_id
        WHERE m.deleted_at IS NULL
          AND (NOT $1::boolean OR m.handled_at IS NULL)
          AND ($2::uuid IS NULL OR m.patient_id = $2)
        ORDER BY m.received_at DESC
        LIMIT 200`,
      [opts.unhandledOnly ?? false, opts.patientId ?? null],
    );
    return rows;
  },

  async markHandled(client: PoolClient, actor: Actor, id: string, patientId?: string) {
    if (!can(actor.role, 'sendMessages')) {
      throw new Forbidden('Your role does not include patient messaging');
    }
    if (patientId) await requirePatientInTenant(client, patientId);
    const { rows } = await client.query(
      `UPDATE luminary.inbound_message
          SET handled_at = now(),
              handled_by = $2,
              patient_id = COALESCE($3, patient_id),
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, actor.userId, patientId ?? null],
    );
    if (!rows[0]) throw new NotFound('Message not found');

    // Attaching a message to a patient writes into their record, so it is
    // recorded as such rather than as an incidental status change.
    if (patientId) {
      await client.query(
        `SELECT luminary.write_audit('Linked a patient message', 'inbound_message', $1, $2, $3, 'notice')`,
        [id, patientId, 'assigned by hand from an unmatched number'],
      );
    }
    return rows[0];
  },
};
