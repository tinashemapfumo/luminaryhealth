import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { Conflict, Forbidden } from '../../platform/errors.js';
import { billingService } from './billing.service.js';
import type { Actor } from './billing.service.js';

const manager: Actor = { userId: 'u-mgr', role: 'manager', practiceId: 'p-1' };
const receptionist: Actor = { userId: 'u-rec', role: 'receptionist', practiceId: 'p-1' };
const doctor: Actor = { userId: 'u-doc', role: 'doctor', practiceId: 'p-1' };

const line = {
  id: 'line-1',
  invoice_id: 'inv-1',
  description: 'General consultation',
  quantity: 1,
  unit_price: 30,
  service_id: 'svc-1',
  exclusion_status: null,
  finalized_at: null,
  patient_id: 'pat-1',
};

function clientFor(overrides: (text: string) => { rows: unknown[] } | undefined) {
  return {
    query: async (text: string) => {
      const hit = overrides(text);
      if (hit) return hit;
      if (text.includes('FROM luminary.invoice_line') && text.includes('finalized_at')) {
        return { rows: [line] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
}

void test('a role without editDraftInvoice cannot change a line quantity', async () => {
  const client = clientFor(() => undefined);
  await assert.rejects(
    billingService.updateLine(client, doctor, 'line-1', { quantity: 2 }),
    Forbidden,
  );
});

void test('overriding a price without a reason is refused', async () => {
  const client = clientFor(() => undefined);
  await assert.rejects(
    billingService.updateLine(client, manager, 'line-1', { unitPrice: 50 }),
    /Say why the price/,
  );
});

void test('a finalized invoice refuses further line edits', async () => {
  const client = clientFor((text) => {
    if (text.includes('FROM luminary.invoice_line') && text.includes('finalized_at')) {
      return { rows: [{ ...line, finalized_at: new Date().toISOString() }] };
    }
    return undefined;
  });
  await assert.rejects(
    billingService.updateLine(client, manager, 'line-1', { quantity: 2 }),
    Conflict,
  );
  await assert.rejects(
    billingService.excludeLine(client, manager, 'line-1', 'Included in package'),
    Conflict,
  );
});

void test('excluding a line without a reason is refused', async () => {
  const client = clientFor(() => undefined);
  await assert.rejects(
    billingService.excludeLine(client, manager, 'line-1', ''),
    /Say why/,
  );
});

void test('excluding an already-excluded line conflicts', async () => {
  const client = clientFor((text) => {
    if (text.includes('FROM luminary.invoice_line') && text.includes('finalized_at')) {
      return { rows: [{ ...line, exclusion_status: 'excluded' }] };
    }
    return undefined;
  });
  await assert.rejects(
    billingService.excludeLine(client, manager, 'line-1', 'Duplicate of another line'),
    Conflict,
  );
});

void test('restoring a line that is not excluded conflicts', async () => {
  const client = clientFor(() => undefined);
  await assert.rejects(
    billingService.restoreLine(client, manager, 'line-1'),
    Conflict,
  );
});

void test('a receptionist cannot finalize an invoice', async () => {
  const client = clientFor(() => undefined);
  await assert.rejects(
    billingService.finalizeInvoice(client, receptionist, 'work-item-1'),
    Forbidden,
  );
});

void test('finalizing refuses when a chargeable line has no price', async () => {
  const workItem = { id: 'work-item-1', status: 'Ready to bill', draft_invoice_id: 'inv-1', patient_id: 'pat-1' };
  const invoice = {
    id: 'inv-1', reference: 'INV-2026-0001', currency: 'USD', total: 30,
    lines: [{ id: 'line-1', description: 'General consultation', unit_price: null, exclusion_status: null }],
  };
  const client = {
    query: async (text: string) => {
      if (text.includes('FROM luminary.billing_work_item') && text.includes('JOIN')) return { rows: [workItem] };
      if (text.includes('FROM luminary.billing_clarification') && text.includes('count(*)')) return { rows: [{ n: 0 }] };
      if (text.includes('FROM luminary.invoice i') || text.includes('FROM luminary.invoice ')) return { rows: [invoice] };
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await assert.rejects(
    billingService.finalizeInvoice(client, manager, 'work-item-1'),
    Conflict,
  );
});

void test('finalizing a work item with open clarifications is refused', async () => {
  const workItem = { id: 'work-item-1', status: 'Needs clarification', draft_invoice_id: 'inv-1', patient_id: 'pat-1' };
  const client = {
    query: async (text: string) => {
      if (text.includes('FROM luminary.billing_work_item') && text.includes('JOIN')) return { rows: [workItem] };
      if (text.includes('FROM luminary.billing_clarification') && text.includes('count(*)')) return { rows: [{ n: 1 }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await assert.rejects(
    billingService.finalizeInvoice(client, manager, 'work-item-1'),
    Conflict,
  );
});

void test('applying a bespoke price for the wrong service is refused', async () => {
  const agreement = {
    id: 'agr-1', service_id: 'svc-other', patient_id: 'pat-1', amount: 20, currency: 'USD',
    status: 'approved', valid_until: null, uses_remaining: null,
  };
  const client = clientFor((text) => {
    if (text.includes('FROM luminary.bespoke_price_agreement')) return { rows: [agreement] };
    return undefined;
  });
  await assert.rejects(
    billingService.applyBespokePrice(client, manager, 'line-1', 'agr-1'),
    /different service/,
  );
});
