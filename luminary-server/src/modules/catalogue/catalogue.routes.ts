import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { catalogueService } from './catalogue.service.js';
import type { Actor } from '../billing/billing.service.js';
import { Unauthorized } from '../../platform/errors.js';

/**
 * Catalogue, tariff, order and import endpoints.
 *
 * Permissions are attached per route rather than to the module, so adding an
 * endpoint without deciding who may call it is a visible omission rather than
 * a silent default. Three authorities are distinguished here on purpose:
 * ordering a service is clinical, publishing a tariff changes what every
 * patient on a scheme is charged, and reading the catalogue is neither.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const repriceBody = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().length(3),
  effectiveFrom: isoDate,
});

const orderBody = z.object({
  patientId: z.string().uuid(),
  serviceId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  quantity: z.number().int().positive().default(1),
  priority: z.enum(['Routine', 'Urgent', 'Stat']).default('Routine'),
  clinicalNotes: z.string().default(''),
});

const orderStatusBody = z.object({
  status: z.enum(['Accepted', 'In progress', 'Completed', 'Cancelled', 'Declined']),
  // Enforced again by a CHECK on the table, so a direct write cannot skip it.
  reason: z.string().trim().min(5).optional(),
});

const tariffRow = z.object({
  serviceId: z.string().uuid(),
  payerId: z.string().uuid(),
  planId: z.string().uuid().nullable().optional(),
  code: z.string().min(1),
  description: z.string().optional(),
  rate: z.number().finite().nonnegative(),
  currency: z.string().length(3),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
  source: z.string().optional(),
});

const serviceRow = z.object({
  internalCode: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  clinicalName: z.string().trim().min(1).optional(),
  billingDescription: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).default('Consultation'),
  department: z.string().trim().min(1).default('General Practice'),
  serviceType: z.string().trim().min(1).default('service'),
  defaultDuration: z.number().int().positive().default(15),
  defaultQuantity: z.number().int().positive().default(1),
  billable: z.boolean().default(true),
  orderable: z.boolean().default(true),
  billingTrigger: z.enum(['ON_ORDER', 'ON_COMPLETION', 'MANUAL']).default('ON_COMPLETION'),
  defaultTariffCode: z.string().trim().nullable().optional(),
  notes: z.string().default(''),
  active: z.boolean().default(true),
  aliases: z.array(z.string().trim().min(1)).default([]),
  price: z.array(z.object({
    amount: z.number().finite().nonnegative().nullable().optional(),
    currency: z.string().length(3).default('USD'),
    effectiveFrom: isoDate.optional(),
    effectiveTo: isoDate.nullable().optional(),
  })).default([]),
});

const publishBody = z.object({
  filename: z.string().min(1),
  payerId: z.string().uuid(),
  mapping: z.record(z.string()).default({}),
  counts: z.record(z.number()).default({}),
  rows: z.array(tariffRow).min(1, 'Nothing to publish'),
});

const publishServicesBody = z.object({
  filename: z.string().min(1),
  mapping: z.record(z.string()).default({}),
  counts: z.record(z.number()).default({}),
  rows: z.array(serviceRow).min(1, 'Nothing to publish'),
});

export async function catalogueRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(actor: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: actor.practiceId, userId: actor.userId }, work);

  app.get('/services', async (request) => {
    const { includeInactive } = z.object({
      includeInactive: z.coerce.boolean().default(false),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => catalogueService.listServices(client, actor, includeInactive));
  });

  // Re-pricing is its own resource: a price is a dated period, and posting a
  // new one is what closes the last. There is deliberately no PUT that would
  // let a caller edit what a past invoice was raised at.
  app.post('/services/:id/prices', {
    preHandler: requirePermission('manageTariffs'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = repriceBody.parse(request.body);
      const actor = actorOf(request);
      const price = await run(actor, (client) =>
        catalogueService.repriceService(client, actor, { serviceId: id, ...body }));
      return reply.code(201).send(price);
    },
  });

  app.post('/services/:id/aliases', {
    preHandler: requirePermission('manageTariffs'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        alias: z.string().trim().min(1),
        payerId: z.string().uuid().nullable().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const alias = await run(actor, (client) =>
        catalogueService.addAlias(client, actor, { serviceId: id, ...body }));
      return reply.code(201).send(alias);
    },
  });

  app.get('/payers', async (request) => {
    const actor = actorOf(request);
    return run(actor, (client) => catalogueService.listPayers(client, actor));
  });

  app.post('/payers', {
    preHandler: requirePermission('manageCover'),
    handler: async (request, reply) => {
      const body = z.object({
        name: z.string().trim().min(1),
        active: z.boolean().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const payer = await run(actor, (client) => catalogueService.createPayer(client, actor, body));
      return reply.code(201).send(payer);
    },
  });

  app.post('/schemes', {
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

  app.get('/tariffs', async (request) => {
    const query = z.object({
      serviceId: z.string().uuid().optional(),
      payerId: z.string().uuid().optional(),
      current: z.coerce.boolean().default(true),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, async (client) => {
      await catalogueService.listPayers(client, actor);   // same authority check
      const { catalogueRepository } = await import('./catalogue.repository.js');
      return catalogueRepository.listTariffs(client, query);
    });
  });

  // --- orders --------------------------------------------------------------

  app.get('/orders', async (request) => {
    const query = z.object({
      status: z.string().optional(),
      patientId: z.string().uuid().optional(),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => catalogueService.listOrders(client, actor, query));
  });

  app.post('/orders', {
    preHandler: requirePermission('orderServices'),
    handler: async (request, reply) => {
      const body = orderBody.parse(request.body);
      const actor = actorOf(request);
      const order = await run(actor, (client) => catalogueService.createOrder(client, actor, body));
      return reply.code(201).send(order);
    },
  });

  /*
   * Status is its own sub-resource rather than a PATCH on the order, because
   * advancing an order is an event with consequences — it is what bills the
   * patient — and not a field edit. The response says whether a charge was
   * raised and, when it was not, why.
   */
  app.post('/orders/:id/status', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = orderStatusBody.parse(request.body);
    const actor = actorOf(request);
    const result = await run(actor, (client) =>
      catalogueService.advanceOrder(client, actor, { id, ...body }));
    return reply.code(200).send(result);
  });

  // --- imports -------------------------------------------------------------

  app.get('/import-batches', async (request) => {
    const actor = actorOf(request);
    return run(actor, (client) => catalogueService.listBatches(client, actor));
  });

  /*
   * Publishing takes rows a person has already reviewed, not a file. Parsing,
   * column mapping and validation happen where the reviewer is, and the server
   * records the decision — so an unreviewed spreadsheet has no path to live
   * pricing at all.
   */
  app.post('/import-batches/tariffs', {
    preHandler: requirePermission('manageTariffs'),
    handler: async (request, reply) => {
      const body = publishBody.parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) =>
        catalogueService.publishTariffBatch(client, actor, body));
      return reply.code(201).send(result);
    },
  });

  app.post('/import-batches/services', {
    preHandler: requirePermission('manageTariffs'),
    handler: async (request, reply) => {
      const body = publishServicesBody.parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) =>
        catalogueService.publishServiceBatch(client, actor, body));
      return reply.code(201).send(result);
    },
  });

  app.post('/import-batches/:id/rollback', {
    preHandler: requirePermission('manageTariffs'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => catalogueService.rollbackBatch(client, actor, id));
    },
  });
}
