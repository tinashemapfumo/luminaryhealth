import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { patientMatchingService } from './patient-matching.service.js';

const clientWith = (...results: unknown[][]) => {
  let index = 0;
  return {
    query: async () => ({ rows: results[index++] ?? [] }),
  } as unknown as PoolClient;
};

void test('exact identity evidence produces one match', async () => {
  const client = clientWith([{
    id: '11111111-1111-1111-1111-111111111111',
    full_name: 'Tariro Moyo',
    date_of_birth: '1991-04-12',
  }]);
  const result = await patientMatchingService.match(client, {
    fullName: ' Tariro   Moyo ', dateOfBirth: '1991-04-12',
    phone: '263771234567', nationalId: '12-345678 A 90',
  });
  assert.deepEqual(result, {
    result: 'matched', patientId: '11111111-1111-1111-1111-111111111111',
  });
});

void test('a correct national ID with contradictory demographics is ambiguous', async () => {
  const client = clientWith([{
    id: '11111111-1111-1111-1111-111111111111',
    full_name: 'Another Person',
    date_of_birth: '1980-01-01',
  }]);
  const result = await patientMatchingService.match(client, {
    fullName: 'Tariro Moyo', dateOfBirth: '1991-04-12',
    phone: '263771234567', nationalId: '12-345678 A 90',
  });
  assert.deepEqual(result, { result: 'ambiguous' });
});

void test('a shared phone is ambiguous even when one name appears plausible', async () => {
  const client = clientWith([
    { id: '1', full_name: 'Tariro Moyo', date_of_birth: '1991-04-12' },
    { id: '2', full_name: 'Rudo Moyo', date_of_birth: '1994-02-13' },
  ]);
  const result = await patientMatchingService.match(client, {
    fullName: 'Tariro Moyo', dateOfBirth: '1991-04-12', phone: '263771234567',
  });
  assert.deepEqual(result, { result: 'ambiguous' });
});

void test('complete evidence with no plausible candidate is a clean no-match', async () => {
  const client = clientWith([], []);
  const result = await patientMatchingService.match(client, {
    fullName: 'Tariro Moyo', dateOfBirth: '1991-04-12', phone: '263771234567',
  });
  assert.deepEqual(result, { result: 'no_match' });
});

void test('incomplete evidence is never guessed', async () => {
  const result = await patientMatchingService.match(clientWith(), { fullName: 'Tariro Moyo' });
  assert.deepEqual(result, { result: 'insufficient_evidence' });
});
