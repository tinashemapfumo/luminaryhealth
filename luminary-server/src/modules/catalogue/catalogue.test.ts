import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { Conflict, Forbidden } from '../../platform/errors.js';
import { catalogueService } from './catalogue.service.js';
import type { Actor } from '../billing/billing.service.js';

const encounter = {
  id: '11111111-1111-1111-1111-111111111111',
  patient_id: '22222222-2222-2222-2222-222222222222',
  appointment_id: null,
  status: 'draft',
  note_type: 'SOAP note',
};

const doctor: Actor = { userId: 'u-doc', role: 'doctor', practiceId: 'p-1' };
const receptionist: Actor = { userId: 'u-rec', role: 'receptionist', practiceId: 'p-1' };

function clientReturning(row: Record<string, unknown> | null) {
  return {
    query: async (text: string) => {
      if (text.includes('FROM luminary.encounter')) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
}

void test('capturing a service event is refused for a role without captureEncounterServices', async () => {
  const client = clientReturning(encounter);
  await assert.rejects(
    catalogueService.createServiceEvent(client, receptionist, encounter.id, {
      serviceId: '33333333-3333-3333-3333-333333333333',
      eventType: 'performed',
    }),
    Forbidden,
  );
});

void test('viewing service events is refused for a role with neither capture nor view-billing-handoff access', async () => {
  const admin: Actor = { userId: 'u-admin', role: 'admin', practiceId: 'p-1' };
  const client = clientReturning(encounter);
  await assert.rejects(catalogueService.listServiceEvents(client, admin, encounter.id), Forbidden);
});

void test('a signed encounter refuses further service capture', async () => {
  const client = clientReturning({ ...encounter, status: 'signed' });
  await assert.rejects(
    catalogueService.createServiceEvent(client, doctor, encounter.id, {
      serviceId: '33333333-3333-3333-3333-333333333333',
      eventType: 'performed',
    }),
    Conflict,
  );
});

void test('a signed encounter refuses removing a captured service event', async () => {
  const client = clientReturning({ ...encounter, status: 'signed' });
  await assert.rejects(
    catalogueService.deleteServiceEvent(client, doctor, encounter.id, '44444444-4444-4444-4444-444444444444'),
    Conflict,
  );
});

void test('a service event linked to a completed order cannot be removed', async () => {
  const eventId = '44444444-4444-4444-4444-444444444444';
  const client = {
    query: async (text: string) => {
      if (text.includes('FROM luminary.encounter') && !text.includes('encounter_service_event')) {
        return { rows: [encounter] };
      }
      if (text.includes('FROM luminary.encounter_service_event')) {
        return { rows: [{ id: eventId, order_status: 'Completed' }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await assert.rejects(
    catalogueService.deleteServiceEvent(client, doctor, encounter.id, eventId),
    Conflict,
  );
});

void test('an already-billed service event is skipped rather than billed twice', async () => {
  const performedEvent = {
    id: '55555555-5555-5555-5555-555555555555',
    service_id: '66666666-6666-6666-6666-666666666666',
    order_id: null,
    quantity: 1,
  };
  const queries: string[] = [];
  const invoiceInserts: unknown[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('FROM luminary.encounter_service_event')) return { rows: [performedEvent] };
      // Idempotency check: an invoice line already carries this event's billing key.
      if (text.includes('FROM luminary.invoice_line') && text.includes('billing_key')) {
        return { rows: [{ id: 'already-billed-line' }] };
      }
      if (text.includes('INSERT INTO luminary.invoice_line')) {
        invoiceInserts.push(text);
        return { rows: [{ id: 'new-line' }] };
      }
      if (text.includes('INSERT INTO luminary.billing_work_item')) {
        return { rows: [{ id: 'work-item-1', status: 'Ready to bill' }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const workItem = await catalogueService.runEncounterBillingHandoff(client, doctor, {
    id: encounter.id,
    patient_id: encounter.patient_id,
    appointment_id: null,
    created_at: new Date().toISOString(),
  });

  assert.equal(invoiceInserts.length, 0, 'an event already carrying an invoice line must not be billed again');
  assert.equal(workItem.id, 'work-item-1');
});
