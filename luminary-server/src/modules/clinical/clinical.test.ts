import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { BadRequest, Conflict, Forbidden } from '../../platform/errors.js';
import { clinicalService, type Actor } from './clinical.service.js';

const doctor: Actor = { userId: 'u-doc', role: 'doctor', practiceId: 'p-1', registrationLapsed: false };
const nurse: Actor = { userId: 'u-nurse', role: 'nurse', practiceId: 'p-1', registrationLapsed: false };

const patientReviewed = {
  full_name: 'Tendai Nyoni', allergies: [], allergies_reviewed: true,
};
const patientUnreviewed = {
  full_name: 'Tendai Nyoni', allergies: [], allergies_reviewed: false,
};
const patientWithAllergy = {
  full_name: 'Tendai Nyoni', allergies: ['Amoxicillin'], allergies_reviewed: true,
};

function clientReturning(
  patientRow: Record<string, unknown>,
  captureInserts?: string[],
  captureParams?: unknown[][],
) {
  return {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes('FROM luminary.patient WHERE id')) return { rows: [patientRow] };
      if (text.includes('FROM luminary.app_user WHERE id')) {
        return { rows: [{ display_name: 'Dr. Chen', registration_number: 'HPCZ-GP-4471' }] };
      }
      if (text.includes('INSERT INTO luminary.prescription')) {
        captureInserts?.push(text);
        captureParams?.push(params ?? []);
        return { rows: [{ id: `rx-${(captureInserts?.length ?? 0)}`, status: 'active' }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
}

void test('a role without prescribe cannot issue a batch', async () => {
  const client = clientReturning(patientReviewed);
  await assert.rejects(
    clinicalService.prescribeBatch(client, nurse, {
      patientId: 'pat-1', items: [{ drug: 'Amoxicillin', strength: '500 mg', route: 'oral', frequency: 'tds' }],
    }),
    Forbidden,
  );
});

void test('an empty batch is refused', async () => {
  const client = clientReturning(patientReviewed);
  await assert.rejects(
    clinicalService.prescribeBatch(client, doctor, { patientId: 'pat-1', items: [] }),
    BadRequest,
  );
});

void test('unreviewed allergies block the whole batch, not just the first item', async () => {
  const inserts: string[] = [];
  const client = clientReturning(patientUnreviewed, inserts);
  await assert.rejects(
    clinicalService.prescribeBatch(client, doctor, {
      patientId: 'pat-1',
      items: [
        { drug: 'Amoxicillin', strength: '500 mg', route: 'oral', frequency: 'tds' },
        { drug: 'Paracetamol', strength: '500 mg', route: 'oral', frequency: 'qds' },
      ],
    }),
    (error: unknown) => error instanceof Conflict && (error as Conflict).details !== undefined
      && (error.details as { code?: string }).code === 'ALLERGY_REVIEW_REQUIRED',
  );
  assert.equal(inserts.length, 0, 'no prescription should be written when the batch is rejected');
});

void test('a recorded allergy clash on any item blocks every item in the batch', async () => {
  const inserts: string[] = [];
  const client = clientReturning(patientWithAllergy, inserts);
  await assert.rejects(
    clinicalService.prescribeBatch(client, doctor, {
      patientId: 'pat-1',
      allergiesReviewed: true,
      items: [
        { drug: 'Paracetamol', strength: '500 mg', route: 'oral', frequency: 'qds' },
        { drug: 'Amoxicillin', strength: '500 mg', route: 'oral', frequency: 'tds' },
      ],
    }),
    Conflict,
  );
  assert.equal(inserts.length, 0, 'a clash on the second drug must stop the first from being written too');
});

void test('a valid batch writes one row per item and returns all of them', async () => {
  const inserts: string[] = [];
  const client = clientReturning(patientReviewed, inserts);
  const created = await clinicalService.prescribeBatch(client, doctor, {
    patientId: 'pat-1',
    items: [
      { drug: 'Amoxicillin', strength: '500 mg', route: 'oral', frequency: 'tds', durationDays: 5 },
      { drug: 'Paracetamol', strength: '500 mg', route: 'oral', frequency: 'qds', durationDays: 5 },
      { drug: 'Loratadine', strength: '10 mg', route: 'oral', frequency: 'od', durationDays: 7 },
    ],
  });
  assert.equal(created.length, 3);
  assert.equal(inserts.length, 3);
});

void test('every medicine in a batch shares one issue group, so it is one prescription', async () => {
  const inserts: string[] = [];
  const params: unknown[][] = [];
  const client = clientReturning(patientReviewed, inserts, params);
  await clinicalService.prescribeBatch(client, doctor, {
    patientId: 'pat-1',
    items: [
      { drug: 'Amoxicillin', strength: '500 mg', route: 'oral', frequency: 'tds', durationDays: 5 },
      { drug: 'Paracetamol', strength: '500 mg', route: 'oral', frequency: 'qds', durationDays: 5 },
    ],
  });
  assert.ok(inserts.every((sql) => sql.includes('issue_group_id')), 'every insert sets issue_group_id');
  const groups = params.map((p) => p.at(-1));
  assert.equal(new Set(groups).size, 1, 'all medicines carry the same issue group');
  assert.match(String(groups[0]), /^[0-9a-f-]{36}$/, 'the issue group is a uuid');
});

void test('two separate batches are two prescriptions', async () => {
  const params: unknown[][] = [];
  const client = clientReturning(patientReviewed, [], params);
  const item = { drug: 'Paracetamol', strength: '500 mg', route: 'oral', frequency: 'qds', durationDays: 5 };
  await clinicalService.prescribeBatch(client, doctor, { patientId: 'pat-1', items: [item] });
  await clinicalService.prescribeBatch(client, doctor, { patientId: 'pat-1', items: [item] });
  assert.notEqual(params[0]?.at(-1), params[1]?.at(-1));
});
