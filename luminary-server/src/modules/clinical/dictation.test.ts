import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import {
  dictationService,
  extractOpenAiResponseText,
  normalizeDraft,
  standardizeDraft,
} from './dictation.js';
import type { Actor } from './clinical.service.js';

const doctor: Actor = { userId: 'u-doc', role: 'doctor', practiceId: 'p-1', registrationLapsed: false };

void test('raw Responses API output text is extracted from message content', () => {
  const text = extractOpenAiResponseText({
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: '{"medicationsMentioned":[]}' }],
    }],
  });

  assert.equal(text, '{"medicationsMentioned":[]}');
});

void test('SDK output_text remains supported', () => {
  assert.equal(extractOpenAiResponseText({ output_text: ' {"subjective":null} ' }), '{"subjective":null}');
});

void test('dictation normalization standardizes prescription fields deterministically', () => {
  const draft = normalizeDraft({
    medicationsMentioned: [{
      drug: ' Amoxicillin ',
      form: 'Capsule',
      strength: '500mg',
      dose: '1 capsule',
      route: 'PO',
      frequency: 'TDS',
      durationDays: 5,
      quantity: 15,
      refills: 0,
      sourceText: 'amoxicillin 500mg one capsule PO TDS for five days',
    }],
  });

  assert.deepEqual(draft.medicationsMentioned[0], {
    drug: 'Amoxicillin',
    form: 'capsule',
    strength: '500 mg',
    dose: '1 capsule',
    route: 'oral',
    frequency: 'three times daily',
    durationDays: 5,
    quantity: 15,
    refills: 0,
    indication: null,
    pharmacy: null,
    substitutionAllowed: null,
    instructions: null,
    sourceText: 'amoxicillin 500mg one capsule PO TDS for five days',
  });
});

void test('dictation normalization drops unsafe numeric output instead of coercing it', () => {
  const draft = normalizeDraft({
    medicationsMentioned: [{
      drug: 'Paracetamol',
      durationDays: -2,
      quantity: 2.5,
      refills: -1,
    }],
  });

  assert.equal(draft.medicationsMentioned[0]?.durationDays, null);
  assert.equal(draft.medicationsMentioned[0]?.quantity, null);
  assert.equal(draft.medicationsMentioned[0]?.refills, 0);
});

void test('encounter-note drafts normalize SOAP text and use matching clinical detail as fallback', () => {
  const draft = standardizeDraft({
    subjective: null,
    objective: '  BP  138/86.  \n  Chest clear. ',
    assessment: '  Viral   upper respiratory infection ',
    plan: null,
    clinicalDetail: {
      chiefComplaint: ' Cough ',
      historyOfPresentIllness: ' Three-day dry cough. ',
      reviewOfSystems: ' No shortness of breath. ',
      examination: 'This should not replace the supplied objective.',
      patientAdvice: ' Maintain oral fluids. ',
      safetyNet: ' Return if breathing worsens. ',
    },
    diagnosesMentioned: [
      { code: ' j06.9 ', label: ' Acute upper respiratory infection ' },
      { code: 'J06.9', label: 'Acute upper respiratory infection' },
    ],
  }, 'encounter_note');

  assert.equal(draft.subjective, 'Cough\nThree-day dry cough.\nNo shortness of breath.');
  assert.equal(draft.objective, 'BP 138/86.\nChest clear.');
  assert.equal(draft.assessment, 'Viral upper respiratory infection');
  assert.equal(draft.plan, 'Maintain oral fluids.\nReturn if breathing worsens.');
  assert.deepEqual(draft.diagnosesMentioned, [{
    code: 'J06.9',
    label: 'Acute upper respiratory infection',
    sourceText: undefined,
  }]);
});

void test('prescription-purpose drafts cannot populate encounter-note fields', () => {
  const draft = standardizeDraft({
    subjective: 'This must not be copied into the note',
    assessment: 'Nor this',
    diagnosesMentioned: [{ code: 'J18.9', label: 'Pneumonia' }],
    medicationsMentioned: [{ drug: 'Amoxicillin', route: 'PO', frequency: 'TDS' }],
  }, 'prescription');

  assert.equal(draft.subjective, null);
  assert.equal(draft.assessment, null);
  assert.deepEqual(draft.diagnosesMentioned, []);
  assert.equal(draft.medicationsMentioned[0]?.route, 'oral');
  assert.equal(draft.medicationsMentioned[0]?.frequency, 'three times daily');
});

void test('captured dictations persist their workflow purpose', async () => {
  let insertParams: unknown[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes('FROM luminary.encounter\n')) {
        return { rows: [{ id: 'enc-1', patient_id: 'pat-1', status: 'draft' }] };
      }
      if (text.includes('INSERT INTO luminary.encounter_dictation')) {
        insertParams = params ?? [];
        return { rows: [{ id: 'dict-1', purpose: params?.at(-1) }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const result = await dictationService.createCaptured(
    client,
    doctor,
    'enc-1',
    { transcript: 'Take amoxicillin five hundred milligrams.', provider: 'test', model: 'test-stt' },
    'prescription',
  );

  assert.equal(insertParams.at(-1), 'prescription');
  assert.equal(result.purpose, 'prescription');
});
