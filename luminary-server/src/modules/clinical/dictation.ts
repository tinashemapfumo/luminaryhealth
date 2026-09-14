import type { PoolClient } from 'pg';
import { config } from '../../platform/config.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';
import { can } from '../../platform/permissions.js';
import { assertSamePatient, requireEncounterInTenant } from '../../platform/tenant-refs.js';
import { clinicalService, type Actor } from './clinical.service.js';

type SuggestedDiagnosis = { code: string; label: string; sourceText?: string };
type SuggestedMedication = {
  drug: string;
  strength?: string | null;
  route?: string | null;
  frequency?: string | null;
  durationDays?: number | null;
  sourceText?: string;
};

export type StructuredDictation = {
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  followUp: string | null;
  diagnosesMentioned: SuggestedDiagnosis[];
  medicationsMentioned: SuggestedMedication[];
  uncertainties: { text: string; reason: string }[];
};

function clean(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function splitSentences(transcript: string) {
  return transcript
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|;\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mockStructure(transcript: string): StructuredDictation {
  const sentences = splitSentences(transcript);
  const lower = transcript.toLowerCase();
  const has = (...words: string[]) => words.some((word) => lower.includes(word));
  const bucket = (words: string[]) =>
    sentences.filter((sentence) => words.some((word) => sentence.toLowerCase().includes(word))).join(' ');

  const subjective = bucket(['complain', 'history', 'reports', 'presenting', 'pain', 'cough', 'fever', 'shortness', 'headache'])
    || sentences.slice(0, 2).join(' ');
  const objective = bucket(['temperature', 'bp', 'blood pressure', 'pulse', 'saturation', 'chest', 'exam', 'crepitation', 'tender']);
  const assessment = bucket(['impression', 'assessment', 'diagnosis', 'possible', 'likely', 'suspect']);
  const plan = bucket(['start', 'give', 'request', 'order', 'review', 'follow', 'x-ray', 'blood', 'test', 'advise']);
  const followUp = bucket(['follow up', 'review in', 'come back', 'return']);

  const diagnosesMentioned: SuggestedDiagnosis[] = [];
  if (has('pneumonia')) diagnosesMentioned.push({ code: 'J18.9', label: 'Pneumonia, unspecified organism', sourceText: 'pneumonia' });
  if (has('hypertension', 'high blood pressure')) diagnosesMentioned.push({ code: 'I10', label: 'Essential (primary) hypertension', sourceText: 'hypertension' });
  if (has('migraine')) diagnosesMentioned.push({ code: 'G43.909', label: 'Migraine, unspecified, not intractable', sourceText: 'migraine' });

  const medicationsMentioned: SuggestedMedication[] = [];
  const medicationPatterns = [
    { drug: 'Amoxicillin/clavulanate', match: /amoxicillin(?:\s*\/?\s*clavulanate| clavulanate| co-amoxiclav)/i },
    { drug: 'Paracetamol', match: /paracetamol/i },
    { drug: 'Ibuprofen', match: /ibuprofen/i },
    { drug: 'Losartan', match: /losartan/i },
    { drug: 'Amlodipine', match: /amlodipine/i },
  ];
  for (const item of medicationPatterns) {
    const found = transcript.match(item.match);
    if (!found) continue;
    const source = sentences.find((sentence) => item.match.test(sentence)) || found[0];
    const strength = source.match(/\b(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|units?))\b/i)?.[1] ?? null;
    const days = source.match(/\b(?:for|x)\s+(\d{1,3})\s+days?\b/i)?.[1];
    medicationsMentioned.push({
      drug: item.drug,
      strength,
      route: null,
      frequency: source.match(/\b(once daily|twice daily|three times daily|tds|bd|od|qid|qds)\b/i)?.[1] ?? null,
      durationDays: days ? Number(days) : null,
      sourceText: source,
    });
  }

  const uncertainties = [];
  if (has('maybe', 'possible', 'possibly', 'unclear', 'not sure')) {
    uncertainties.push({ text: 'Diagnostic or treatment certainty may be limited', reason: 'Transcript contains uncertainty language' });
  }
  if (medicationsMentioned.some((med) => !med.strength || !med.frequency)) {
    uncertainties.push({ text: 'Medication details incomplete', reason: 'Dose or frequency was not clearly captured for every medication' });
  }

  return {
    subjective: clean(subjective),
    objective: clean(objective),
    assessment: clean(assessment),
    plan: clean(plan),
    followUp: clean(followUp),
    diagnosesMentioned,
    medicationsMentioned,
    uncertainties,
  };
}

async function openAiStructure(transcript: string): Promise<StructuredDictation> {
  if (!config.sttApiKey) throw new Conflict('OpenAI credentials are not configured');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.sttApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.clinicalAiModel,
      input: [
        {
          role: 'system',
          content: 'Extract only transcript-supported clinical documentation. Return strict JSON with SOAP fields, diagnosis suggestions, medication suggestions, and uncertainties. Do not invent facts.',
        },
        { role: 'user', content: transcript },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'clinical_dictation_draft',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['subjective', 'objective', 'assessment', 'plan', 'followUp', 'diagnosesMentioned', 'medicationsMentioned', 'uncertainties'],
            properties: {
              subjective: { type: ['string', 'null'] },
              objective: { type: ['string', 'null'] },
              assessment: { type: ['string', 'null'] },
              plan: { type: ['string', 'null'] },
              followUp: { type: ['string', 'null'] },
              diagnosesMentioned: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['code', 'label', 'sourceText'],
                  properties: {
                    code: { type: 'string' },
                    label: { type: 'string' },
                    sourceText: { type: 'string' },
                  },
                },
              },
              medicationsMentioned: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['drug', 'strength', 'route', 'frequency', 'durationDays', 'sourceText'],
                  properties: {
                    drug: { type: 'string' },
                    strength: { type: ['string', 'null'] },
                    route: { type: ['string', 'null'] },
                    frequency: { type: ['string', 'null'] },
                    durationDays: { type: ['number', 'null'] },
                    sourceText: { type: 'string' },
                  },
                },
              },
              uncertainties: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['text', 'reason'],
                  properties: {
                    text: { type: 'string' },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Conflict('Clinical structuring provider failed');
  const payload = await response.json() as { output_text?: string };
  const text = payload.output_text;
  if (!text) throw new Conflict('Clinical structuring provider returned no draft');
  return normalizeDraft(JSON.parse(text));
}

function normalizeDraft(value: Partial<StructuredDictation>): StructuredDictation {
  return {
    subjective: clean(value.subjective),
    objective: clean(value.objective),
    assessment: clean(value.assessment),
    plan: clean(value.plan),
    followUp: clean(value.followUp),
    diagnosesMentioned: Array.isArray(value.diagnosesMentioned) ? value.diagnosesMentioned.map((item) => ({
      code: String(item.code || '').trim(),
      label: String(item.label || '').trim(),
      sourceText: clean(item.sourceText) ?? undefined,
    })).filter((item) => item.code && item.label) : [],
    medicationsMentioned: Array.isArray(value.medicationsMentioned) ? value.medicationsMentioned.map((item) => ({
      drug: String(item.drug || '').trim(),
      strength: clean(item.strength),
      route: clean(item.route),
      frequency: clean(item.frequency),
      durationDays: item.durationDays == null ? null : Number(item.durationDays),
      sourceText: clean(item.sourceText) ?? undefined,
    })).filter((item) => item.drug) : [],
    uncertainties: Array.isArray(value.uncertainties) ? value.uncertainties.map((item) => ({
      text: String(item.text || '').trim(),
      reason: String(item.reason || '').trim(),
    })).filter((item) => item.text && item.reason) : [],
  };
}

async function structureTranscript(transcript: string) {
  if (config.clinicalAiProvider === 'openai') return openAiStructure(transcript);
  return mockStructure(transcript);
}

async function dictationFor(client: PoolClient, id: string) {
  const { rows } = await client.query(
    `SELECT *
       FROM luminary.encounter_dictation
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [id],
  );
  if (!rows[0]) throw new NotFound('Dictation not found');
  return rows[0];
}

function requireDoctor(actor: Actor) {
  if (actor.role !== 'doctor' || !can(actor.role, 'prescribe')) {
    throw new Forbidden('Doctor dictation is available to authorised doctors only');
  }
  if (actor.registrationLapsed) {
    throw new Forbidden('Your practising registration has lapsed');
  }
}

export const dictationService = {
  async createFromTranscript(client: PoolClient, actor: Actor, encounterId: string, transcript: string) {
    requireDoctor(actor);
    const text = transcript.trim();
    if (text.length < 12) throw new BadRequest('Dictation transcript is too short to structure');
    if (text.length > 12000) throw new BadRequest('Dictation transcript is too long');

    const encounter = await requireEncounterInTenant(client, encounterId);
    const { rows } = await client.query(
      `INSERT INTO luminary.encounter_dictation
         (practice_id, patient_id, encounter_id, created_by, stt_provider, stt_model,
          clinical_ai_provider, clinical_ai_model, raw_transcript)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        encounter.patient_id,
        encounterId,
        actor.userId,
        'manual',
        config.sttModel,
        config.clinicalAiProvider,
        config.clinicalAiModel,
        text,
      ],
    );
    await client.query(
      `SELECT luminary.write_audit('Captured doctor dictation transcript', 'encounter', $1, $2, $3, 'notice')`,
      [encounterId, 'manual transcript', rows[0].id],
    );
    return rows[0];
  },

  async structure(client: PoolClient, actor: Actor, id: string) {
    requireDoctor(actor);
    const row = await dictationFor(client, id);
    const encounter = await requireEncounterInTenant(client, row.encounter_id);
    assertSamePatient(encounter.patient_id, row.patient_id, 'Dictation patient does not match encounter patient');
    if (row.created_by !== actor.userId) throw new Forbidden('Only the dictating doctor can structure this draft');
    if (!['captured', 'structured', 'failed'].includes(row.status)) {
      throw new Conflict('This dictation has already been approved or discarded');
    }

    try {
      const draft = await structureTranscript(row.raw_transcript);
      const { rows } = await client.query(
        `UPDATE luminary.encounter_dictation
            SET status = 'structured',
                structured_draft = $2,
                clinical_ai_provider = $3,
                clinical_ai_model = $4,
                error_code = NULL,
                error_message = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, JSON.stringify(draft), config.clinicalAiProvider, config.clinicalAiModel],
      );
      await client.query(
        `SELECT luminary.write_audit('Structured doctor dictation draft', 'encounter', $1, $2, $3, 'notice')`,
        [row.encounter_id, config.clinicalAiModel, id],
      );
      return rows[0];
    } catch (error) {
      await client.query(
        `UPDATE luminary.encounter_dictation
            SET status = 'failed', error_code = 'STRUCTURE_FAILED', error_message = $2, updated_at = now()
          WHERE id = $1`,
        [id, error instanceof Error ? error.message : 'Structuring failed'],
      );
      throw error;
    }
  },

  async updateDraft(client: PoolClient, actor: Actor, id: string, draft: StructuredDictation) {
    requireDoctor(actor);
    const row = await dictationFor(client, id);
    if (row.created_by !== actor.userId) throw new Forbidden('Only the dictating doctor can edit this draft');
    if (row.status !== 'structured') throw new Conflict('Only structured dictation drafts can be edited');
    const { rows } = await client.query(
      `UPDATE luminary.encounter_dictation SET structured_draft = $2, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(normalizeDraft(draft))],
    );
    await client.query(
      `SELECT luminary.write_audit('Edited doctor dictation draft', 'encounter', $1, NULL, $2, 'notice')`,
      [row.encounter_id, id],
    );
    return rows[0];
  },

  async approveNote(client: PoolClient, actor: Actor, id: string, fields: Record<string, unknown>) {
    requireDoctor(actor);
    const row = await dictationFor(client, id);
    if (row.created_by !== actor.userId) throw new Forbidden('Only the dictating doctor can approve this draft');
    if (row.status !== 'structured') throw new Conflict('Only structured dictation drafts can be approved');
    const draft = normalizeDraft(row.structured_draft ?? {});
    const noteFields = {
      subjective: clean(fields.subjective) ?? draft.subjective ?? undefined,
      objective: clean(fields.objective) ?? draft.objective ?? undefined,
      assessment: clean(fields.assessment) ?? draft.assessment ?? undefined,
      plan: clean(fields.plan) ?? draft.plan ?? undefined,
      follow_up: clean(fields.follow_up ?? fields.followUp) ?? draft.followUp ?? undefined,
      diagnoses: Array.isArray(fields.diagnoses) ? fields.diagnoses : draft.diagnosesMentioned.map(({ code, label }) => ({ code, label })),
    };
    const cleanFields = Object.fromEntries(Object.entries(noteFields).filter(([, value]) => value !== undefined));
    if (Object.keys(cleanFields).length === 0) throw new BadRequest('No note fields selected for approval');

    const saved = await clinicalService.saveDraft(client, actor, row.encounter_id, cleanFields);
    const { rows } = await client.query(
      `UPDATE luminary.encounter_dictation
          SET status = 'note_approved',
              approved_note_fields = $2,
              approved_by = $3,
              approved_at = now(),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(cleanFields), actor.userId],
    );
    await client.query(
      `SELECT luminary.write_audit('Approved doctor dictation into encounter note', 'encounter', $1, $2, $3, 'notice')`,
      [row.encounter_id, 'SOAP fields', id],
    );
    return { dictation: rows[0], encounter: saved };
  },

  async approvePrescription(client: PoolClient, actor: Actor, id: string, medication: SuggestedMedication & { allergiesReviewed?: boolean }) {
    requireDoctor(actor);
    const row = await dictationFor(client, id);
    if (row.created_by !== actor.userId) throw new Forbidden('Only the dictating doctor can approve this prescription draft');
    if (!['structured', 'note_approved'].includes(row.status)) throw new Conflict('Only structured dictation drafts can be approved');
    if (!medication.drug?.trim()) throw new BadRequest('Medication name is required');

    const prescription = await clinicalService.prescribe(client, actor, {
      patientId: row.patient_id,
      encounterId: row.encounter_id,
      drug: medication.drug,
      strength: medication.strength ?? undefined,
      route: medication.route ?? undefined,
      frequency: medication.frequency ?? undefined,
      durationDays: medication.durationDays ?? undefined,
      refills: 0,
      allergiesReviewed: medication.allergiesReviewed,
    });
    const { rows } = await client.query(
      `UPDATE luminary.encounter_dictation
          SET status = 'prescription_approved',
              approved_prescription_id = $2,
              approved_by = $3,
              approved_at = COALESCE(approved_at, now()),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, prescription.id, actor.userId],
    );
    await client.query(
      `SELECT luminary.write_audit('Approved doctor dictation into prescription', 'encounter', $1, $2, $3, 'notice')`,
      [row.encounter_id, medication.drug, id],
    );
    return { dictation: rows[0], prescription };
  },

  async get(client: PoolClient, actor: Actor, id: string) {
    requireDoctor(actor);
    const row = await dictationFor(client, id);
    if (row.created_by !== actor.userId) throw new Forbidden('Only the dictating doctor can view this dictation');
    return row;
  },
};
