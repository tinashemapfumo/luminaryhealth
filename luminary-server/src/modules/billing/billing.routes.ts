import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { billingService, type Actor } from './billing.service.js';
import { Unauthorized } from '../../platform/errors.js';

const money = z.number().finite().nonnegative();

const createInvoiceBody = z.object({
  patientId: z.string().uuid(),
  currency: z.string().length(3),
  dueInDays: z.number().int().min(0).max(365).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  lines: z.array(z.object({
    origin: z.enum(['manual', 'clinical']).default('manual'),
    serviceId: z.string().uuid().nullable().optional(),
    orderId: z.string().uuid().nullable().optional(),
    encounterId: z.string().uuid().nullable().optional(),
    code: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    quantity: z.number().int().positive().default(1),
    unitPrice: money.optional(),
  })).min(1, 'An invoice needs at least one line'),
});

const paymentBody = z.object({
  amount: z.number().finite().positive(),
  currency: z.string().length(3),
  // Required only when tendering in a currency other than the invoice's; the
  // service enforces that, since it knows the invoice.
  fxRate: z.number().finite().positive().optional(),
  method: z.enum(['cash', 'ecocash', 'card', 'transfer', 'medical_aid']),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  responsibilityBucket: z.enum(['patient', 'insurer']).optional(),
  claimId: z.string().uuid().optional(),
  remittanceId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  paymentReference: z.string().trim().min(3).max(160).optional(),
});

const adjustmentBody = z.object({
  kind: z.enum(['write_off', 'credit_note']),
  amount: z.number().finite().positive(),
  responsibilityBucket: z.enum(['patient', 'insurer', 'denied']).optional(),
  claimId: z.string().uuid().optional(),
  claimLineId: z.string().uuid().optional(),
  // Matched by a CHECK constraint on the table, so a caller that bypasses this
  // schema still cannot write an unexplained adjustment.
  reason: z.string().trim().min(10, 'Give a fuller reason. This is a permanent financial record.'),
});

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoDateTime = z.string().datetime({ offset: true });
const collectionStatus = z.enum(['OPEN', 'FOLLOW_UP', 'DISPUTED', 'RESOLVED']);
const debtorType = z.enum(['PATIENT', 'INSURER', 'UNRESOLVED_DENIAL']);
const actionType = z.enum(['NOTE', 'PHONE_CALL', 'FOLLOW_UP', 'EMAIL', 'WHATSAPP', 'STATUS_CHANGE', 'ASSIGNMENT']);

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(actor: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: actor.practiceId, userId: actor.userId }, work);

  app.get('/invoices', async (request) => {
    const query = z.object({
      patientId: z.string().uuid().optional(),
      status: z.string().optional(),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.listInvoices(client, actor, query));
  });

  app.get('/invoices/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.getInvoice(client, actor, id));
  });

  app.get('/payments', async (request) => {
    const query = z.object({
      from: dateOnly.optional(),
      to: dateOnly.optional(),
      patientId: z.string().uuid().optional(),
      invoiceId: z.string().uuid().optional(),
      actorId: z.string().uuid().optional(),
      method: z.enum(['cash', 'ecocash', 'card', 'transfer', 'medical_aid']).optional(),
      responsibilityBucket: z.enum(['patient', 'insurer']).optional(),
      claimId: z.string().uuid().optional(),
      payerId: z.string().uuid().optional(),
      reversalStatus: z.enum(['original', 'reversal', 'reversed', 'unreversed']).optional(),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.listPayments(client, actor, query));
  });

  app.post('/invoices', {
    preHandler: requirePermission('createInvoice'),
    handler: async (request, reply) => {
      const body = createInvoiceBody.parse(request.body);
      const actor = actorOf(request);
      const invoice = await run(actor, (client) => billingService.createInvoice(client, actor, body));
      return reply.code(201).send(invoice);
    },
  });

  // Payments are their own resource, not a field on the invoice — that is what
  // makes the ledger append-only rather than a mutable total.
  app.post('/invoices/:id/payments', {
    preHandler: requirePermission('recordPayment'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = paymentBody.parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) =>
        billingService.recordPayment(client, actor, { invoiceId: id, ...body }),
      );
      return reply.code(201).send(result);
    },
  });

  app.post('/payments/:id/reversal', {
    preHandler: requirePermission('recordPayment'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason } = z.object({ reason: z.string().min(10) }).parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) => billingService.reversePayment(client, actor, id, reason));
      return reply.code(201).send(result);
    },
  });

  // An adjustment is its own resource for the same reason a payment is: it is
  // a ledger entry, not a field on the invoice that someone can overwrite.
  app.post('/invoices/:id/adjustments', {
    preHandler: requirePermission('adjustBalance'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = adjustmentBody.parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) =>
        billingService.adjustBalance(client, actor, { invoiceId: id, ...body }),
      );
      return reply.code(201).send(result);
    },
  });

  app.get('/patients/:id/statement', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.statement(client, actor, id));
  });

  app.get('/reports/aging', async (request) => {
    const query = z.object({ asOf: dateOnly.optional() }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.aging(client, actor, query));
  });

  app.get('/reports/collections', async (request) => {
    const query = z.object({
      from: dateOnly.optional(),
      to: dateOnly.optional(),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.collections(client, actor, query));
  });

  app.get('/collections/cases', async (request) => {
    const query = z.object({
      debtorType: debtorType.optional(),
      status: collectionStatus.optional(),
      assignedTo: z.string().uuid().optional(),
      assigned: z.enum(['me']).optional(),
      nextAction: z.enum(['due', 'overdue']).optional(),
      includeResolved: z.coerce.boolean().optional(),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.listCollectionCases(client, actor, query));
  });

  app.post('/collections/cases', async (request, reply) => {
    const body = z.object({
      invoiceId: z.string().uuid(),
      claimId: z.string().uuid().nullable().optional(),
      debtorType,
      assignedTo: z.string().uuid().nullable().optional(),
      nextActionAt: isoDateTime.nullable().optional(),
      status: collectionStatus.optional(),
    }).parse(request.body);
    const actor = actorOf(request);
    const result = await run(actor, (client) => billingService.createCollectionCase(client, actor, body));
    return reply.code(201).send(result);
  });

  app.get('/collections/cases/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.getCollectionCase(client, actor, id));
  });

  app.patch('/collections/cases/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: collectionStatus.optional(),
      assignedTo: z.string().uuid().nullable().optional(),
      nextActionAt: isoDateTime.nullable().optional(),
      note: z.string().trim().min(3).optional(),
    }).parse(request.body);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.updateCollectionCase(client, actor, id, body));
  });

  app.post('/collections/cases/:id/actions', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      actionType,
      note: z.string().trim().min(3),
      nextActionAt: isoDateTime.nullable().optional(),
      reference: z.string().trim().min(1).nullable().optional(),
    }).parse(request.body);
    const actor = actorOf(request);
    const result = await run(actor, (client) => billingService.recordCollectionAction(client, actor, id, body));
    return reply.code(201).send(result);
  });

  // --- billing handoff: work queue and editable draft invoice --------------

  app.get('/billing/work-items', async (request) => {
    const query = z.object({ status: z.string().optional() }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.listWorkItems(client, actor, query));
  });

  app.get('/billing/work-items/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.getWorkItem(client, actor, id));
  });

  app.post('/billing/work-items/:id/clarifications', {
    preHandler: requirePermission('requestBillingClarification'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        category: z.enum(['missing_service', 'service_not_completed', 'diagnosis_code', 'quantity', 'pricing_agreement', 'other']),
        question: z.string().trim().min(5),
      }).parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) => billingService.requestClarification(client, actor, id, body));
      return reply.code(201).send(result);
    },
  });

  app.post('/billing/clarifications/:id/response', {
    preHandler: requirePermission('requestBillingClarification'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { response } = z.object({ response: z.string().trim().min(2) }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.respondClarification(client, actor, id, response));
    },
  });

  app.post('/billing/draft-invoices/:id/catalogue-lines', {
    preHandler: requirePermission('addCatalogueInvoiceLine'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ serviceId: z.string().uuid(), quantity: z.number().positive().optional() }).parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) => billingService.addCatalogueLine(client, actor, id, body));
      return reply.code(201).send(result);
    },
  });

  app.post('/billing/draft-invoices/:id/custom-lines', {
    preHandler: requirePermission('addCustomInvoiceLine'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        description: z.string().trim().min(1),
        quantity: z.number().positive(),
        unitPrice: money,
      }).parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) => billingService.addCustomLine(client, actor, id, body));
      return reply.code(201).send(result);
    },
  });

  app.patch('/billing/draft-invoices/lines/:lineId', async (request) => {
    const { lineId } = z.object({ lineId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      quantity: z.number().positive().optional(),
      unitPrice: money.optional(),
      reason: z.string().trim().optional(),
    }).parse(request.body);
    const actor = actorOf(request);
    return run(actor, (client) => billingService.updateLine(client, actor, lineId, body));
  });

  app.post('/billing/draft-invoices/lines/:lineId/exclude', {
    preHandler: requirePermission('excludeAutomatedInvoiceLine'),
    handler: async (request) => {
      const { lineId } = z.object({ lineId: z.string().uuid() }).parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.excludeLine(client, actor, lineId, reason));
    },
  });

  app.post('/billing/draft-invoices/lines/:lineId/restore', {
    preHandler: requirePermission('excludeAutomatedInvoiceLine'),
    handler: async (request) => {
      const { lineId } = z.object({ lineId: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.restoreLine(client, actor, lineId));
    },
  });

  app.post('/billing/draft-invoices/lines/:lineId/bespoke-price', {
    preHandler: requirePermission('overrideInvoicePrice'),
    handler: async (request) => {
      const { lineId } = z.object({ lineId: z.string().uuid() }).parse(request.params);
      const { agreementId } = z.object({ agreementId: z.string().uuid() }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.applyBespokePrice(client, actor, lineId, agreementId));
    },
  });

  app.post('/billing/draft-invoices/:id/reorder', {
    preHandler: requirePermission('editDraftInvoice'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { lineIds } = z.object({ lineIds: z.array(z.string().uuid()) }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.reorderLines(client, actor, id, lineIds));
    },
  });

  app.patch('/billing/draft-invoices/:id/patient-note', {
    preHandler: requirePermission('editDraftInvoice'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { note } = z.object({ note: z.string().max(500) }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.setPatientNote(client, actor, id, note));
    },
  });

  app.post('/billing/work-items/:id/finalize', {
    preHandler: requirePermission('finalizeInvoice'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.finalizeInvoice(client, actor, id));
    },
  });

  app.post('/patients/:patientId/bespoke-prices', async (request, reply) => {
    const { patientId } = z.object({ patientId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      serviceId: z.string().uuid(),
      amount: z.number().positive(),
      currency: z.string().length(3),
      reason: z.string().trim().min(5),
      scope: z.enum(['one_encounter', 'date_range', 'use_count']).optional(),
      encounterId: z.string().uuid().optional(),
      appointmentId: z.string().uuid().optional(),
      validUntil: dateOnly.optional(),
      usesRemaining: z.number().int().positive().optional(),
    }).parse(request.body);
    const actor = actorOf(request);
    const result = await run(actor, (client) =>
      billingService.createBespokePriceAgreement(client, actor, { patientId, ...body }),
    );
    return reply.code(201).send(result);
  });

  app.post('/bespoke-prices/:id/approve', {
    preHandler: requirePermission('approveBespokePrice'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => billingService.approveBespokePriceAgreement(client, actor, id));
    },
  });
}
