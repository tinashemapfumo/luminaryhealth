import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { can, requirePermission, type Role } from '../../platform/permissions.js';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../../platform/errors.js';
import { catalogueService } from '../catalogue/catalogue.service.js';

/**
 * Practice configuration.
 *
 * Everything here was a constant in the frontend until it became configuration —
 * providers, rooms, hours, schemes, tariffs. They are tables because they differ
 * per practice and change without a deployment.
 *
 * Integration credentials are handled differently from everything else: the
 * fields stored here are *identifiers* (a provider number, a sender id). Secrets
 * belong in a secret store, are write-only from the API, and are never returned
 * to a browser — so there is no endpoint below that reads one back.
 */

interface Actor { userId: string; role: Role; practiceId: string }

const claimEmailDestinationBody = z.object({
  label: z.string().trim().min(1).max(160),
  payerId: z.string().uuid().nullable(),
  schemeId: z.string().uuid().nullable(),
  email: z.string().trim().email(),
  ccEmail: z.string().trim().email().nullable().optional(),
  purpose: z.enum(['CLAIMS', 'PREAUTHORISATION', 'QUERIES', 'REMITTANCE']).default('CLAIMS'),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  notes: z.string().trim().max(1000).nullable().optional(),
  verified: z.boolean().default(false),
}).refine((value) => !value.schemeId || value.payerId, {
  message: 'A scheme-specific destination must also select its payer', path: ['payerId'],
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(a: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: a.practiceId, userId: a.userId }, work);

  /**
   * Readable by any signed-in user: the calendar needs opening hours, billing
   * needs the currency. Only the integration identifiers are held back, and
   * only from roles without `manageIntegrations`.
   */
  app.get('/settings', async (request) => {
    const actor = actorOf(request);
    return run(actor, async (client) => {
      const [practice, settings, rooms, schemes, tariffs, providers, payers, claimEmailDestinations] = await Promise.all([
        client.query(
          `SELECT id, name, short_name, address_line, city, phone, email,
                  primary_currency, secondary_currency, usd_rate, plan
             FROM luminary.practice WHERE id = luminary.current_practice_id()`),
        client.query(`SELECT * FROM luminary.practice_settings WHERE practice_id = luminary.current_practice_id()`),
        client.query(`SELECT id, name, kind, active FROM luminary.room WHERE deleted_at IS NULL ORDER BY name`),
        client.query(`SELECT id, payer_id, name, reimburse_percent, requires_preauth, active
                        FROM luminary.scheme WHERE deleted_at IS NULL ORDER BY name`),
        client.query(`SELECT code, description, price, currency, active
                        FROM luminary.service_tariff WHERE deleted_at IS NULL ORDER BY code`),
        client.query(`SELECT id, display_name, job_title, registration_number, registration_expires, active
                        FROM luminary.app_user
                       WHERE is_provider AND deleted_at IS NULL ORDER BY display_name`),
        client.query(`SELECT id, name, active FROM luminary.payer WHERE deleted_at IS NULL ORDER BY name`),
        client.query(`SELECT d.*, p.name AS payer_name, s.name AS scheme_name
                        FROM luminary.claim_email_destination d
                        LEFT JOIN luminary.payer p ON p.id = d.payer_id
                        LEFT JOIN luminary.scheme s ON s.id = d.scheme_id
                       WHERE d.deleted_at IS NULL
                       ORDER BY d.active DESC, p.name NULLS LAST, s.name NULLS LAST, d.label`),
      ]);

      const config = settings.rows[0] ?? {};
      const integrations = can(actor.role, 'manageIntegrations')
        ? {
            nh263ProviderNumber: config.nh263_provider_number,
            nh263Endpoint: config.nh263_endpoint,
            smsSenderId: config.sms_sender_id,
            smsGateway: config.sms_gateway,
            executiveInsightWebhookUrl: config.executive_insight_webhook_url,
          }
        : undefined;

      return {
        practice: practice.rows[0],
        hours: {
          opensAt: config.opens_at,
          closesAt: config.closes_at,
          slotMinutes: config.slot_minutes,
          openDays: config.open_days,
          timezone: config.timezone,
        },
        security: {
          idleTimeoutMinutes: config.idle_timeout_minutes,
          minimumPasswordLength: config.minimum_password_length,
          breakGlassEnabled: config.break_glass_enabled,
          enforceRegistration: config.enforce_registration,
        },
        providers: providers.rows,
        rooms: rooms.rows,
        schemes: schemes.rows,
        payers: payers.rows,
        claimEmailDestinations: claimEmailDestinations.rows,
        tariffs: tariffs.rows,
        ...(integrations ? { integrations } : {}),
      };
    });
  });

  app.get('/settings/claim-email-destinations', {
    preHandler: requirePermission('manageCover'),
    handler: async (request) => {
      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `SELECT d.*, p.name AS payer_name, s.name AS scheme_name
             FROM luminary.claim_email_destination d
             LEFT JOIN luminary.payer p ON p.id = d.payer_id
             LEFT JOIN luminary.scheme s ON s.id = d.scheme_id
            WHERE d.deleted_at IS NULL
            ORDER BY d.active DESC, p.name NULLS LAST, s.name NULLS LAST, d.label`,
        );
        return rows;
      });
    },
  });

  app.post('/settings/claim-email-destinations', {
    preHandler: requirePermission('manageCover'),
    handler: async (request, reply) => {
      const body = claimEmailDestinationBody.parse(request.body);
      const actor = actorOf(request);
      const destination = await run(actor, async (client) => {
        if (body.schemeId) {
          const { rows } = await client.query(
            `SELECT 1 FROM luminary.scheme WHERE id = $1 AND payer_id = $2 AND deleted_at IS NULL`,
            [body.schemeId, body.payerId],
          );
          if (!rows[0]) throw new BadRequest('The selected scheme does not belong to that payer');
        }
        if (body.isDefault) {
          await client.query(
            `UPDATE luminary.claim_email_destination SET is_default = false, updated_at = now()
              WHERE payer_id IS NOT DISTINCT FROM $1::uuid
                AND scheme_id IS NOT DISTINCT FROM $2::uuid
                AND purpose = $3 AND deleted_at IS NULL`,
            [body.payerId, body.schemeId, body.purpose],
          );
        }
        const { rows } = await client.query(
          `INSERT INTO luminary.claim_email_destination
             (practice_id, payer_id, scheme_id, label, email, cc_email, purpose,
              is_default, active, notes, verified_at, created_by)
           VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
                   CASE WHEN $10 THEN now() ELSE NULL END, $11)
           RETURNING *`,
          [body.payerId, body.schemeId, body.label, body.email, body.ccEmail || null,
           body.purpose, body.isDefault, body.active, body.notes || null, body.verified, actor.userId],
        );
        await client.query(
          `SELECT luminary.write_audit('Created claim email destination', 'payer', $1, $2, $3, 'notice')`,
          [rows[0].id, body.label, body.email],
        );
        return rows[0];
      });
      return reply.code(201).send(destination);
    },
  });

  app.put('/settings/claim-email-destinations/:id', {
    preHandler: requirePermission('manageCover'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = claimEmailDestinationBody.parse(request.body);
      const actor = actorOf(request);
      return run(actor, async (client) => {
        if (body.schemeId) {
          const { rows } = await client.query(
            `SELECT 1 FROM luminary.scheme WHERE id = $1 AND payer_id = $2 AND deleted_at IS NULL`,
            [body.schemeId, body.payerId],
          );
          if (!rows[0]) throw new BadRequest('The selected scheme does not belong to that payer');
        }
        if (body.isDefault) {
          await client.query(
            `UPDATE luminary.claim_email_destination SET is_default = false, updated_at = now()
              WHERE id <> $1 AND payer_id IS NOT DISTINCT FROM $2::uuid
                AND scheme_id IS NOT DISTINCT FROM $3::uuid
                AND purpose = $4 AND deleted_at IS NULL`,
            [id, body.payerId, body.schemeId, body.purpose],
          );
        }
        const { rows } = await client.query(
          `UPDATE luminary.claim_email_destination SET
             payer_id = $2, scheme_id = $3, label = $4, email = $5, cc_email = $6,
             purpose = $7, is_default = $8, active = $9, notes = $10,
             verified_at = CASE WHEN $11 THEN COALESCE(verified_at, now()) ELSE NULL END,
             updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
          [id, body.payerId, body.schemeId, body.label, body.email, body.ccEmail || null,
           body.purpose, body.isDefault, body.active, body.notes || null, body.verified],
        );
        if (!rows[0]) throw new NotFound('Claim email destination not found');
        await client.query(
          `SELECT luminary.write_audit('Changed claim email destination', 'payer', $1, $2, $3, 'notice')`,
          [id, body.label, body.email],
        );
        return rows[0];
      });
    },
  });

  app.delete('/settings/claim-email-destinations/:id', {
    preHandler: requirePermission('manageCover'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.claim_email_destination
              SET active = false, deleted_at = now(), updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL RETURNING id, label, email`,
          [id],
        );
        if (!rows[0]) throw new NotFound('Claim email destination not found');
        await client.query(
          `SELECT luminary.write_audit('Removed claim email destination', 'payer', $1, $2, $3, 'notice')`,
          [id, rows[0].label, rows[0].email],
        );
        return rows[0];
      });
    },
  });

  app.patch('/settings/practice', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request) => {
      const body = z.object({
        name: z.string().min(1).optional(),
        shortName: z.string().min(1).optional(),
        addressLine: z.string().optional(),
        city: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        primaryCurrency: z.string().length(3).optional(),
        secondaryCurrency: z.string().length(3).nullable().optional(),
        usdRate: z.number().positive().optional(),
        timezone: z.string().trim().min(1).optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        if (body.timezone) {
          const { rows: zones } = await client.query(
            `SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1`,
            [body.timezone],
          );
          if (!zones[0]) throw new BadRequest('Invalid practice timezone');
        }
        const { rows } = await client.query(
          `UPDATE luminary.practice SET
             name = COALESCE($1, name), short_name = COALESCE($2, short_name),
             address_line = COALESCE($3, address_line), city = COALESCE($4, city),
             phone = COALESCE($5, phone), email = COALESCE($6, email),
             primary_currency = COALESCE($7, primary_currency),
             secondary_currency = COALESCE($8, secondary_currency),
             usd_rate = COALESCE($9, usd_rate),
             updated_at = now()
           WHERE id = luminary.current_practice_id()
           RETURNING *`,
          [body.name ?? null, body.shortName ?? null, body.addressLine ?? null, body.city ?? null,
           body.phone ?? null, body.email ?? null, body.primaryCurrency ?? null,
           body.secondaryCurrency ?? null, body.usdRate ?? null],
        );
        if (body.timezone) {
          await client.query(
            `UPDATE luminary.practice_settings
                SET timezone = $1, updated_at = now()
              WHERE practice_id = luminary.current_practice_id()`,
            [body.timezone],
          );
        }
        const { rows: settingsRows } = await client.query(
          `SELECT timezone FROM luminary.practice_settings
            WHERE practice_id = luminary.current_practice_id()`,
        );
        await client.query(`SELECT luminary.write_audit('Changed practice profile', 'practice', NULL, $1, NULL, 'notice')`,
          [rows[0].short_name]);
        return { ...rows[0], timezone: settingsRows[0]?.timezone ?? 'Africa/Harare' };
      });
    },
  });

  app.patch('/settings/hours', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request) => {
      const body = z.object({
        opensAt: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        closesAt: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        slotMinutes: z.number().int().min(5).max(60).optional(),
        openDays: z.array(z.string()).min(1).optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.practice_settings SET
             opens_at = COALESCE($1::time, opens_at),
             closes_at = COALESCE($2::time, closes_at),
             slot_minutes = COALESCE($3, slot_minutes),
             open_days = COALESCE($4, open_days)
           WHERE practice_id = luminary.current_practice_id()
           RETURNING opens_at, closes_at, slot_minutes, open_days`,
          [body.opensAt ?? null, body.closesAt ?? null, body.slotMinutes ?? null, body.openDays ?? null],
        );
        if (!rows[0]) throw new NotFound('Settings not initialised for this practice');
        await client.query(`SELECT luminary.write_audit('Changed opening hours', 'practice', NULL, NULL, $1, 'notice')`,
          [`${rows[0].opens_at}-${rows[0].closes_at}`]);
        return rows[0];
      });
    },
  });

  app.put('/settings/schemes/:id', {
    preHandler: requirePermission('manageCover'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        reimbursePercent: z.number().min(0).max(100).optional(),
        requiresPreauth: z.boolean().optional(),
        active: z.boolean().optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.scheme SET
             reimburse_percent = COALESCE($2, reimburse_percent),
             requires_preauth = COALESCE($3, requires_preauth),
             active = COALESCE($4, active)
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING *`,
          [id, body.reimbursePercent ?? null, body.requiresPreauth ?? null, body.active ?? null],
        );
        if (!rows[0]) throw new NotFound('Scheme not found');
        // A rate change alters what every future invoice bills, so it is a
        // notable event rather than a quiet edit.
        await client.query(
          `SELECT luminary.write_audit('Changed scheme rate', 'scheme', $1, $2, $3, 'notice')`,
          [id, rows[0].name, `${rows[0].reimburse_percent}%`],
        );
        return rows[0];
      });
    },
  });

  app.post('/settings/schemes', {
    preHandler: requirePermission('manageCover'),
    handler: async (request, reply) => {
      const body = z.object({
        payerId: z.string().uuid(),
        name: z.string().trim().min(1),
        reimbursePercent: z.number().min(0).max(100).default(0),
        requiresPreauth: z.boolean().default(false),
        active: z.boolean().default(true),
      }).parse(request.body);

      const actor = actorOf(request);
      const scheme = await run(actor, (client) => catalogueService.createScheme(client, actor, body));
      return reply.code(201).send(scheme);
    },
  });

  app.post('/settings/rooms', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request, reply) => {
      const body = z.object({ name: z.string().min(1), kind: z.string().default('Consulting') }).parse(request.body);
      const actor = actorOf(request);
      const room = await run(actor, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO luminary.room (practice_id, name, kind)
           VALUES (luminary.current_practice_id(), $1, $2) RETURNING *`,
          [body.name, body.kind],
        );
        return rows[0];
      });
      return reply.code(201).send(room);
    },
  });

  app.patch('/settings/rooms/:id', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        name: z.string().min(1).optional(),
        kind: z.string().optional(),
        active: z.boolean().optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.room SET
             name = COALESCE($2, name),
             kind = COALESCE($3, kind),
             active = COALESCE($4, active),
             updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING *`,
          [id, body.name ?? null, body.kind ?? null, body.active ?? null],
        );
        if (!rows[0]) throw new NotFound('Room not found');
        await client.query(
          `SELECT luminary.write_audit('Changed room', 'practice', $1, $2, NULL, 'notice')`,
          [id, rows[0].name],
        );
        return rows[0];
      });
    },
  });

  app.delete('/settings/rooms/:id', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.room SET active = false, deleted_at = now()
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, name`,
          [id],
        );
        if (!rows[0]) throw new NotFound('Room not found');
        await client.query(
          `SELECT luminary.write_audit('Removed room', 'practice', $1, $2, NULL, 'notice')`,
          [id, rows[0].name],
        );
        return rows[0];
      });
    },
  });

  app.post('/settings/tariffs', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request, reply) => {
      const body = z.object({
        code: z.string().min(1),
        description: z.string().min(1),
        price: z.number().nonnegative(),
        currency: z.string().length(3),
      }).parse(request.body);
      const actor = actorOf(request);
      const tariff = await run(actor, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO luminary.service_tariff (practice_id, code, description, price, currency)
           VALUES (luminary.current_practice_id(), $1, $2, $3, $4)
           ON CONFLICT (practice_id, code)
             DO UPDATE SET description = EXCLUDED.description, price = EXCLUDED.price,
                           currency = EXCLUDED.currency, active = true
           RETURNING *`,
          [body.code, body.description, body.price, body.currency],
        );
        return rows[0];
      });
      return reply.code(201).send(tariff);
    },
  });

  app.patch('/settings/security', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request) => {
      const body = z.object({
        idleTimeoutMinutes: z.number().int().min(1).max(240).optional(),
        minimumPasswordLength: z.number().int().min(8).max(128).optional(),
        breakGlassEnabled: z.boolean().optional(),
        enforceRegistration: z.boolean().optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.practice_settings SET
             idle_timeout_minutes = COALESCE($1, idle_timeout_minutes),
             minimum_password_length = COALESCE($2, minimum_password_length),
             break_glass_enabled = COALESCE($3, break_glass_enabled),
             enforce_registration = COALESCE($4, enforce_registration)
           WHERE practice_id = luminary.current_practice_id()
           RETURNING idle_timeout_minutes, minimum_password_length,
                     break_glass_enabled, enforce_registration`,
          [
            body.idleTimeoutMinutes ?? null,
            body.minimumPasswordLength ?? null,
            body.breakGlassEnabled ?? null,
            body.enforceRegistration ?? null,
          ],
        );
        if (!rows[0]) throw new NotFound('Settings not initialised for this practice');
        await client.query(
          `SELECT luminary.write_audit('Changed security policy', 'practice', NULL, NULL, NULL, 'alert')`,
        );
        return rows[0];
      });
    },
  });

  // Identifiers only — see the note at the top of this file.
  app.patch('/settings/integrations', {
    preHandler: requirePermission('manageIntegrations'),
    handler: async (request) => {
      const body = z.object({
        nh263ProviderNumber: z.string().optional(),
        nh263Endpoint: z.string().url().optional(),
        smsSenderId: z.string().max(11).optional(),
        smsGateway: z.string().optional(),
        executiveInsightWebhookUrl: z.string().url().nullable().optional(),
        executiveInsightWebhookSecret: z.string().min(16).max(500).nullable().optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      if (!can(actor.role, 'manageIntegrations')) throw new Forbidden('Restricted to administrators');

      return run(actor, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.practice_settings SET
             nh263_provider_number = COALESCE($1, nh263_provider_number),
             nh263_endpoint = COALESCE($2, nh263_endpoint),
             sms_sender_id = COALESCE($3, sms_sender_id),
             sms_gateway = COALESCE($4, sms_gateway),
             executive_insight_webhook_url = CASE WHEN $5::boolean THEN $6 ELSE executive_insight_webhook_url END,
             executive_insight_webhook_secret = CASE WHEN $7::boolean THEN $8 ELSE executive_insight_webhook_secret END
           WHERE practice_id = luminary.current_practice_id()
           RETURNING nh263_provider_number, nh263_endpoint, sms_sender_id, sms_gateway,
                     executive_insight_webhook_url`,
          [body.nh263ProviderNumber ?? null, body.nh263Endpoint ?? null,
           body.smsSenderId ?? null, body.smsGateway ?? null,
           Object.hasOwn(body, 'executiveInsightWebhookUrl'), body.executiveInsightWebhookUrl ?? null,
           Object.hasOwn(body, 'executiveInsightWebhookSecret'), body.executiveInsightWebhookSecret ?? null],
        );
        await client.query(
          `SELECT luminary.write_audit('Changed integration settings', 'practice', NULL, NULL, NULL, 'alert')`,
        );
        return rows[0];
      });
    },
  });
}
