import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { Conflict } from '../../platform/errors.js';
import { agentService, fingerprintRequest, type Conversation } from './agent.service.js';
import { followupService } from './followup.service.js';
import { runPracticeBatches } from './followup.reconciliation.js';

const conversation = {
  id: '11111111-1111-1111-1111-111111111111',
  patient_id: '22222222-2222-2222-2222-222222222222',
} as Conversation;

void test('unknown structured response requires clinical review', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes('FROM luminary.agent_action')) return { rows: [] };
      return { rows: [{ id: 'followup', status: 'escalated' }] };
    },
  } as unknown as PoolClient;

  const result = await followupService.recordResponse(client, 'followup', conversation, {
    responseKey: 'response-key',
    summary: 'Test uncertainty',
    patientResponse: { answer: 'unknown' },
    symptomStatus: 'unknown',
    medicationAdherence: 'as_directed',
    requiresClinicalReview: false,
  });

  assert.equal(result.requiresClinicalReview, true);
  const update = queries.find((query) => query.text.includes('UPDATE luminary.patient_followup'));
  assert.equal(update?.values?.[5], true);
});

void test('same idempotency key with a different fingerprint conflicts', async () => {
  const original = fingerprintRequest({ fullName: 'Patient One' });
  const changed = fingerprintRequest({ fullName: 'Patient Two' });
  const client = {
    query: async () => ({ rows: [{ tool: 'register_patient', request_fingerprint: original }] }),
  } as unknown as PoolClient;

  await assert.rejects(
    agentService.replay(client, conversation.id, 'registration-key', 'register_patient', changed),
    Conflict,
  );
});

void test('reconciliation continues after one practice fails', async () => {
  const visited: string[] = [];
  const result = await runPracticeBatches(
    [{ practice_id: 'practice-a' }, { practice_id: 'practice-b' }, { practice_id: 'practice-c' }],
    async (practiceId) => {
      visited.push(practiceId);
      if (practiceId === 'practice-b') throw new Error('malformed fixture');
      return 1;
    },
  );

  assert.deepEqual(visited, ['practice-a', 'practice-b', 'practice-c']);
  assert.equal(result.created, 2);
  assert.deepEqual(result.failures, [{ practiceId: 'practice-b', error: 'malformed fixture' }]);
});
