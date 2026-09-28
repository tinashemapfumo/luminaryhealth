import type { PoolClient } from 'pg';
import { config } from '../../platform/config.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';
import { can } from '../../platform/permissions.js';
import { assertSamePatient, requireEncounterInTenant } from '../../platform/tenant-refs.js';
import { clinicalService, type Actor } from './clinical.service.js';

type SuggestedDiagnosis = { code: string; label: string; sourceText?: string };
export type DictationPurpose = 'encounter_note' | 'prescription';
type StructuredClinicalDetail = {
  chiefComplaint: string | null;
  historyOfPresentIllness: string | null;
  reviewOfSystems: string | null;
  examination: string | null;
  patientAdvice: string | null;
  safetyNet: string | null;
};
type SuggestedMedication = {
  drug: string;
  form?: string | null;
  strength?: string | null;
  dose?: string | null;
  route?: string | null;
  frequency?: string | null;
  durationDays?: number | null;
  quantity?: number | null;
  refills?: number | null;
  indication?: string | null;
  pharmacy?: string | null;
  substitutionAllowed?: boolean | null;
  instructions?: string | null;
  sourceText?: string;
};

export type StructuredDictation = {
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  followUp: string | null;
  clinicalDetail: StructuredClinicalDetail;
  diagnosesMentioned: SuggestedDiagnosis[];
  medicationsMentioned: SuggestedMedication[];
  uncertainties: { text: string; reason: string }[];
};

type TranscriptionSource = {
  transcript: string;
  provider: string;
  model: string | null;
};

type OpenAiResponsePayload = {
  output_text?: string;
  status?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
};

function clean(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function positiveInteger(value: unknown, allowZero = false): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) return null;
  return number;
}

function normalizeStrength(value: unknown): string | null {
  const text = clean(value);
  if (!text) return null;
  return text.replace(/\s+/g, ' ').replace(/(\d)\s*(mcg|mg|g|ml|l|units?)\b/gi, '$1 $2').toLowerCase();
}

function normalizeRoute(value: unknown): string | null {
  const text = clean(value)?.toLowerCase();
  if (!text) return null;
  const routes: Record<string, string> = {
    po: 'oral', orally: 'oral', 'by mouth': 'oral', oral: 'oral',
    iv: 'IV', intravenous: 'IV', im: 'IM', intramuscular: 'IM',
    sc: 'subcutaneous', sq: 'subcutaneous', subcutaneous: 'subcutaneous',
    topical: 'topical', inhaled: 'inhaled', rectal: 'rectal', ophthalmic: 'ophthalmic',
  };
  return routes[text] ?? text;
}

function normalizeFrequency(value: unknown): string | null {
  const text = clean(value)?.toLowerCase();
  if (!text) return null;
  const frequencies: Record<string, string> = {
    od: 'once daily', daily: 'once daily', 'once a day': 'once daily', 'once daily': 'once daily',
    bd: 'twice daily', bid: 'twice daily', 'twice a day': 'twice daily', 'twice daily': 'twice daily',
    tds: 'three times daily', tid: 'three times daily', 'three times a day': 'three times daily', 'three times daily': 'three times daily',
    qds: 'four times daily', qid: 'four times daily', 'four times a day': 'four times daily', 'four times daily': 'four times daily',
  };
  return frequencies[text] ?? text;
}

function normalizeClinicalDetail(value: Partial<StructuredClinicalDetail> | null | undefined): StructuredClinicalDetail {
  return {
    chiefComplaint: clean(value?.chiefComplaint),
    historyOfPresentIllness: clean(value?.historyOfPresentIllness),
    reviewOfSystems: clean(value?.reviewOfSystems),
    examination: clean(value?.examination),
    patientAdvice: clean(value?.patientAdvice),
    safetyNet: clean(value?.safetyNet),
  };
}

export function extractOpenAiResponseText(payload: OpenAiResponsePayload): string | null {
  const sdkText = clean(payload.output_text);
  if (sdkText) return sdkText;

  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => clean(part.text))
    .filter((part): part is string => Boolean(part))
    .join('\n');
  return clean(text);
}

function audioFilename(contentType: string) {
  if (contentType.includes('mp4')) return 'dictation.mp4';
  if (contentType.includes('mpeg')) return 'dictation.mp3';
  if (contentType.includes('ogg')) return 'dictation.ogg';
  if (contentType.includes('wav')) return 'dictation.wav';
  return 'dictation.webm';
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
      form: null,
      strength,
      dose: null,
      route: null,
      frequency: source.match(/\b(once daily|twice daily|three times daily|tds|bd|od|qid|qds)\b/i)?.[1] ?? null,
      durationDays: days ? Number(days) : null,
      quantity: null,
      refills: 0,
      indication: null,
      pharmacy: null,
      substitutionAllowed: null,
      instructions: null,
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
    clinicalDetail: {
      chiefComplaint: clean(subjective),
      historyOfPresentIllness: clean(subjective),
      reviewOfSystems: null,
      examination: clean(objective),
      patientAdvice: null,
      safetyNet: null,
    },
    diagnosesMentioned,
    medicationsMentioned,
    uncertainties,
  };
}

async function openAiStructure(transcript: string, purpose: DictationPurpose): Promise<StructuredDictation> {
  if (!config.sttApiKey) throw new Conflict('OpenAI credentials are not configured');
  // A bad model name or a malformed schema is a 400, not a hang — but without
  // a client-side ceiling a slow provider round-trip leaves the doctor
  // watching a spinner for as long as the request takes to fail, which reads
  // as "broken" long before the real error ever surfaces.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.sttApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.clinicalAiModel,
        store: false,
        input: [
          {
            role: 'system',
            content: purpose === 'prescription'
              ? 'Extract only transcript-supported prescription information. Populate medicationsMentioned and uncertainties. Leave note and diagnosis fields empty or null. Keep drug, form, strength, dose, route, frequency, duration, quantity, refills, indication, pharmacy, substitution, and instructions separate. Use null for anything not spoken. Do not infer or invent facts.'
              : 'Extract only transcript-supported clinical documentation. Return SOAP fields, structured clinical detail, diagnosis suggestions, medication mentions, and uncertainties. Separate chief complaint, history of presenting illness, review of systems, examination, patient advice, and safety-net instructions. Keep dose separate from strength and frequency. Use null for anything not spoken. Do not infer or invent facts.',
          },
          { role: 'user', content: transcript },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: purpose === 'prescription' ? 'prescription_dictation_draft' : 'encounter_note_dictation_draft',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['subjective', 'objective', 'assessment', 'plan', 'followUp', 'clinicalDetail', 'diagnosesMentioned', 'medicationsMentioned', 'uncertainties'],
              properties: {
                subjective: { type: ['string', 'null'] },
                objective: { type: ['string', 'null'] },
                assessment: { type: ['string', 'null'] },
                plan: { type: ['string', 'null'] },
                followUp: { type: ['string', 'null'] },
                clinicalDetail: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['chiefComplaint', 'historyOfPresentIllness', 'reviewOfSystems', 'examination', 'patientAdvice', 'safetyNet'],
                  properties: {
                    chiefComplaint: { type: ['string', 'null'] },
                    historyOfPresentIllness: { type: ['string', 'null'] },
                    reviewOfSystems: { type: ['string', 'null'] },
                    examination: { type: ['string', 'null'] },
                    patientAdvice: { type: ['string', 'null'] },
                    safetyNet: { type: ['string', 'null'] },
                  },
                },
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
                    required: [
                      'drug', 'form', 'strength', 'dose', 'route', 'frequency', 'durationDays',
                      'quantity', 'refills', 'indication', 'pharmacy', 'substitutionAllowed',
                      'instructions', 'sourceText',
                    ],
                    properties: {
                      drug: { type: 'string' },
                      form: { type: ['string', 'null'] },
                      strength: { type: ['string', 'null'] },
                      dose: { type: ['string', 'null'] },
                      route: { type: ['string', 'null'] },
                      frequency: { type: ['string', 'null'] },
                      durationDays: { type: ['number', 'null'] },
                      quantity: { type: ['number', 'null'] },
                      refills: { type: ['number', 'null'] },
                      indication: { type: ['string', 'null'] },
                      pharmacy: { type: ['string', 'null'] },
                      substitutionAllowed: { type: ['boolean', 'null'] },
                      instructions: { type: ['string', 'null'] },
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
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Conflict('Clinical structuring provider timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // The response body is the provider's own error text — never the
    // request, never the key — so it is safe to log in full. Without this the
    // only visible symptom was a generic 409 with no way to tell a bad model
    // name from a malformed schema from a quota error.
    const errorBody = await response.text().catch(() => '');
    console.error('Clinical structuring provider rejected the request', {
      status: response.status, model: config.clinicalAiModel, body: errorBody.slice(0, 2000),
    });
    throw new Conflict('Clinical structuring provider failed');
  }
  const payload = await response.json() as OpenAiResponsePayload;
  const text = extractOpenAiResponseText(payload);
  if (!text) {
    console.error('Clinical structuring provider returned no text output', {
      status: payload.status,
      outputTypes: payload.output?.map((item) => item.type) ?? [],
    });
    throw new Conflict('Clinical structuring provider returned no draft');
  }
  return standardizeDraft(JSON.parse(text), purpose);
}

export function normalizeDraft(value: Partial<StructuredDictation>): StructuredDictation {
  return {
    subjective: clean(value.subjective),
    objective: clean(value.objective),
    assessment: clean(value.assessment),
    plan: clean(value.plan),
    followUp: clean(value.followUp),
    clinicalDetail: normalizeClinicalDetail(value.clinicalDetail),
    diagnosesMentioned: Array.isArray(value.diagnosesMentioned) ? value.diagnosesMentioned.map((item) => ({
      code: String(item.code || '').trim(),
      label: String(item.label || '').trim(),
      sourceText: clean(item.sourceText) ?? undefined,
    })).filter((item) => item.code && item.label) : [],
    medicationsMentioned: Array.isArray(value.medicationsMentioned) ? value.medicationsMentioned.map((item) => ({
      drug: String(item.drug || '').trim(),
      form: clean(item.form)?.toLowerCase() ?? null,
      strength: normalizeStrength(item.strength),
      dose: clean(item.dose),
      route: normalizeRoute(item.route),
      frequency: normalizeFrequency(item.frequency),
      durationDays: positiveInteger(item.durationDays),
      quantity: positiveInteger(item.quantity),
      refills: positiveInteger(item.refills, true) ?? 0,
      indication: clean(item.indication),
      pharmacy: clean(item.pharmacy),
      substitutionAllowed: typeof item.substitutionAllowed === 'boolean' ? item.substitutionAllowed : null,
      instructions: clean(item.instructions),
      sourceText: clean(item.sourceText) ?? undefined,
    })).filter((item) => item.drug) : [],
    uncertainties: Array.isArray(value.uncertainties) ? value.uncertainties.map((item) => ({
      text: String(item.text || '').trim(),
      reason: String(item.reason || '').trim(),
    })).filter((item) => item.text && item.reason) : [],
  };
}

export function standardizeDraft(
  value: Partial<StructuredDictation>,
  purpose: DictationPurpose = 'encounter_note',
): StructuredDictation {
  const draft = normalizeDraft(value);
  if (purpose !== 'prescription') return draft;
  return {
    ...draft,
    subjective: null,
    objective: null,
    assessment: null,
    plan: null,
    followUp: null,
    clinicalDetail: normalizeClinicalDetail(null),
    diagnosesMentioned: [],
  };
}

async function structureTranscript(transcript: string, purpose: DictationPurpose) {
  if (config.clinicalAiProvider === 'openai') return openAiStructure(transcript, purpose);
  return standardizeDraft(mockStructure(transcript), purpose);
}

async function transcribeAudio(audio: Buffer, contentType: string): Promise<TranscriptionSource> {
  if (config.sttProvider !== 'openai') {
    throw new Conflict('Audio transcription is not configured');
  }
  if (!config.sttApiKey) throw new Conflict('OpenAI credentials are not configured');

  if (audio.length < 256) throw new BadRequest('Dictation audio is too short to transcribe');
  if (audio.length > 25 * 1024 * 1024) throw new BadRequest('Dictation audio is too large');

  const form = new FormData();
  form.append('model', config.sttModel);
  form.append('language', 'en');
  form.append(
    'prompt',
    'Medical consultation dictation in English, with possible Zimbabwean clinical context. Preserve medication names, doses, durations, vitals, and ICD-relevant diagnoses.',
  );
  form.append('file', new Blob([Uint8Array.from(audio)], { type: contentType }), audioFilename(contentType));

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.sttApiKey}` },
    body: form,
  });
  if (!response.ok) throw new Conflict('Speech-to-text provider failed');
  const payload = await response.json() as { text?: string };
  const transcript = clean(payload.text);
  if (!transcript) throw new Conflict('Speech-to-text provider returned no transcript');
  return { transcript, provider: config.sttProvider, model: config.sttModel };
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
  async createFromTranscript(
    client: PoolClient,
    actor: Actor,
    encounterId: string,
    transcript: string,
    purpose: DictationPurpose = 'encounter_note',
  ) {
    requireDoctor(actor);
    const text = transcript.trim();
    if (text.length < 12) throw new BadRequest('Dictation transcript is too short to structure');
    if (text.length > 12000) throw new BadRequest('Dictation transcript is too long');
    return this.createCaptured(client, actor, encounterId, {
      transcript: text,
      provider: 'manual',
      model: config.sttModel,
    }, purpose);
  },

  async createFromAudio(
    client: PoolClient,
    actor: Actor,
    encounterId: string,
    audio: Buffer,
    contentType: string,
    purpose: DictationPurpose = 'encounter_note',
  ) {
    requireDoctor(actor);
    const source = await transcribeAudio(audio, contentType);
    if (source.transcript.length < 12) throw new BadRequest('Dictation transcript is too short to structure');
    if (source.transcript.length > 12000) throw new BadRequest('Dictation transcript is too long');
    return this.createCaptured(client, actor, encounterId, source, purpose);
  },

  async createCaptured(
    client: PoolClient,
    actor: Actor,
    encounterId: string,
    source: TranscriptionSource,
    purpose: DictationPurpose = 'encounter_note',
  ) {
    const encounter = await requireEncounterInTenant(client, encounterId);
    const { rows } = await client.query(
      `INSERT INTO luminary.encounter_dictation
         (practice_id, patient_id, encounter_id, created_by, stt_provider, stt_model,
          clinical_ai_provider, clinical_ai_model, raw_transcript, purpose)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        encounter.patient_id,
        encounterId,
        actor.userId,
        source.provider,
        source.model,
        config.clinicalAiProvider,
        config.clinicalAiModel,
        source.transcript,
        purpose,
      ],
    );
    await client.query(
      `SELECT luminary.write_audit('Captured doctor dictation transcript', 'encounter', $1, $2, $3, 'notice')`,
      [
        encounterId,
        `${purpose}: ${source.provider === 'manual' ? 'manual transcript' : `${source.provider} transcription`}`,
        rows[0].id,
      ],
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
      const purpose: DictationPurpose = row.purpose === 'prescription' ? 'prescription' : 'encounter_note';
      const draft = await structureTranscript(row.raw_transcript, purpose);
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
    if (row.purpose === 'prescription') throw new Conflict('Prescription dictation cannot be approved as an encounter note');
    if (row.status !== 'structured') throw new Conflict('Only structured dictation drafts can be approved');
    const draft = normalizeDraft(row.structured_draft ?? {});
    const noteFields = {
      subjective: clean(fields.subjective) ?? draft.subjective ?? undefined,
      objective: clean(fields.objective) ?? draft.objective ?? undefined,
      assessment: clean(fields.assessment) ?? draft.assessment ?? undefined,
      plan: clean(fields.plan) ?? draft.plan ?? undefined,
      follow_up: clean(fields.follow_up ?? fields.followUp) ?? draft.followUp ?? undefined,
      structured_note: normalizeClinicalDetail(
        (fields.structuredNote as Partial<StructuredClinicalDetail> | undefined) ?? draft.clinicalDetail,
      ),
      diagnoses: Array.isArray(fields.diagnoses) ? fields.diagnoses : draft.diagnosesMentioned.map(({ code, label }) => ({ code, label })),
    };
    const cleanFields = Object.fromEntries(Object.entries(noteFields).filter(([, value]) => value !== undefined));
    if (Object.keys(cleanFields).length === 0) throw new BadRequest('No note fields selected for approval');

    const saved = await clinicalService.saveDraft(client, actor, row.encounter_id, cleanFields);
    const { rows } = await client.query(
      `UPDATE luminary.encounter_dictation
          SET approved_note_fields = $2,
              note_approved_by = $3,
              note_approved_at = now(),
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

  async approvePrescriptions(
    client: PoolClient,
    actor: Actor,
    id: string,
    input: { medications: Array<SuggestedMedication & { sourceIndex: number }>; allergiesReviewed?: boolean },
  ) {
    requireDoctor(actor);
    const row = await dictationFor(client, id);
    if (row.created_by !== actor.userId) throw new Forbidden('Only the dictating doctor can approve these prescription drafts');
    if (row.status !== 'structured') throw new Conflict('Only structured dictation drafts can be approved');
    if (!input.medications.length) throw new BadRequest('Add at least one medication');

    const prescriptions = await clinicalService.prescribeBatch(client, actor, {
      patientId: row.patient_id,
      encounterId: row.encounter_id,
      allergiesReviewed: input.allergiesReviewed,
      sourceDictationId: id,
      items: input.medications.map((medication) => ({
        ...medication,
        form: medication.form ?? undefined,
        strength: medication.strength ?? undefined,
        dose: medication.dose ?? undefined,
        route: medication.route ?? undefined,
        frequency: medication.frequency ?? undefined,
        durationDays: medication.durationDays ?? undefined,
        quantity: medication.quantity ?? undefined,
        refills: medication.refills ?? 0,
        indication: medication.indication ?? undefined,
        pharmacy: medication.pharmacy ?? undefined,
        substitutionAllowed: medication.substitutionAllowed ?? undefined,
        instructions: medication.instructions ?? undefined,
      })),
    });
    const { rows } = await client.query(
      `UPDATE luminary.encounter_dictation SET updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    await client.query(
      `SELECT luminary.write_audit('Approved doctor dictation into prescription', 'encounter', $1, $2, $3, 'notice')`,
      [row.encounter_id, input.medications.map((item) => item.drug).join(', '), id],
    );
    return { dictation: rows[0], prescriptions };
  },

  async approvePrescription(
    client: PoolClient,
    actor: Actor,
    id: string,
    medication: SuggestedMedication & { sourceIndex?: number; allergiesReviewed?: boolean },
  ) {
    const result = await this.approvePrescriptions(client, actor, id, {
      medications: [{ ...medication, sourceIndex: medication.sourceIndex ?? 0 }],
      allergiesReviewed: medication.allergiesReviewed,
    });
    return { dictation: result.dictation, prescription: result.prescriptions[0] };
  },

  async get(client: PoolClient, actor: Actor, id: string) {
    requireDoctor(actor);
    const row = await dictationFor(client, id);
    if (row.created_by !== actor.userId) throw new Forbidden('Only the dictating doctor can view this dictation');
    return row;
  },
};
