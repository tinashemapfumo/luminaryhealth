import { randomUUID } from 'node:crypto';
import pg from 'pg';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const DB = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';
const PRACTICE_A = process.env.PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const PRACTICE_B = process.env.PRACTICE_B_ID || '22222222-2222-2222-2222-222222222222';
const PASSWORD = process.env.PASSWORD || process.env.LUMINARY_TEST_PASSWORD || 'luminary';

const USERS = {
  managerA: process.env.MANAGER_EMAIL || 'manager.test@h.co.zw',
  doctorA: process.env.DOCTOR_EMAIL || 'doctor.test@h.co.zw',
  receptionistA: process.env.RECEPTION_EMAIL || 'reception.test@h.co.zw',
  doctorB: process.env.DOCTOR_B_EMAIL || 'ncube@b.co.zw',
};

const ok = (name, detail = '') => console.log(`ok - ${name}${detail ? `: ${detail}` : ''}`);
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

async function signIn(practiceId, email) {
  const { response, payload } = await request('/auth/session', {
    method: 'POST',
    body: { practiceId, email, password: PASSWORD },
  });
  expect(response.status === 201, `sign-in failed for ${email}: ${response.status} ${JSON.stringify(payload)}`);
  return payload.token;
}

async function main() {
  const manager = await signIn(PRACTICE_A, USERS.managerA);
  const doctor = await signIn(PRACTICE_A, USERS.doctorA);
  const receptionist = await signIn(PRACTICE_A, USERS.receptionistA);
  const doctorB = await signIn(PRACTICE_B, USERS.doctorB);
  ok('authenticated pilot roles');

  const stamp = randomUUID().slice(0, 8);
  const patient = await request('/patients', {
    method: 'POST',
    token: manager,
    body: {
      reference: `DICT-${stamp}`,
      fullName: `Dictation Pilot ${stamp}`,
      dateOfBirth: '1980-02-03',
      sex: 'Male',
      phone: `077${Math.floor(1000000 + Math.random() * 8999999)}`,
      addressCity: 'Harare',
      emergencyName: 'Dictation Contact',
      emergencyRelation: 'Sibling',
      emergencyPhone: `071${Math.floor(1000000 + Math.random() * 8999999)}`,
      consentTreatment: true,
      consentComms: true,
    },
  });
  expect(patient.response.status === 201, `patient create failed: ${patient.response.status} ${JSON.stringify(patient.payload)}`);

  const encounter = await request('/encounters', {
    method: 'POST',
    token: doctor,
    body: { patientId: patient.payload.id, noteType: 'SOAP note' },
  });
  expect(encounter.response.status === 201, `encounter create failed: ${encounter.response.status} ${JSON.stringify(encounter.payload)}`);
  ok('doctor created encounter draft');

  const transcript = 'Patient reports three days of productive cough, fever and shortness of breath. Temperature is 38.2 and chest has bilateral basal crepitations. Impression possible community acquired pneumonia. Start amoxicillin clavulanate 625 mg three times daily for 7 days and request chest X-ray and full blood count.';
  const denied = await request(`/encounters/${encounter.payload.id}/dictations`, {
    method: 'POST',
    token: receptionist,
    body: { transcript },
  });
  expect(denied.response.status === 403, `receptionist dictation was not denied: ${denied.response.status}`);
  ok('non-doctor dictation fails closed');

  const created = await request(`/encounters/${encounter.payload.id}/dictations`, {
    method: 'POST',
    token: doctor,
    body: { transcript },
  });
  expect(created.response.status === 201, `dictation create failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  expect(created.payload.raw_transcript === transcript, 'raw transcript was not preserved');
  ok('doctor captured raw transcript separately');

  const structured = await request(`/dictations/${created.payload.id}/structure`, {
    method: 'POST',
    token: doctor,
  });
  expect(structured.response.ok, `dictation structure failed: ${structured.response.status} ${JSON.stringify(structured.payload)}`);
  expect(structured.payload.status === 'structured', 'dictation status is not structured');
  expect(structured.payload.structured_draft.assessment, 'structured assessment missing');
  expect(structured.payload.structured_draft.medicationsMentioned?.[0]?.drug, 'medication suggestion missing');
  ok('dictation returned organized clinical draft');

  const before = await request(`/encounters/${encounter.payload.id}`, { token: doctor });
  expect(!before.payload.assessment, 'encounter mutated before approval');
  ok('encounter remained unchanged before approval');

  const crossTenantRead = await request(`/dictations/${created.payload.id}`, { token: doctorB });
  expect(crossTenantRead.response.status === 404, `cross-tenant dictation leaked: ${crossTenantRead.response.status}`);
  ok('cross-tenant dictation access returns not found');

  const approved = await request(`/dictations/${created.payload.id}/approve-note`, {
    method: 'POST',
    token: doctor,
    body: {
      subjective: structured.payload.structured_draft.subjective,
      objective: structured.payload.structured_draft.objective,
      assessment: structured.payload.structured_draft.assessment,
      plan: structured.payload.structured_draft.plan,
      followUp: structured.payload.structured_draft.followUp,
      diagnoses: structured.payload.structured_draft.diagnosesMentioned.map(({ code, label }) => ({ code, label })),
    },
  });
  expect(approved.response.ok, `approve note failed: ${approved.response.status} ${JSON.stringify(approved.payload)}`);
  expect(approved.payload.encounter.assessment, 'approved encounter assessment missing');
  expect(approved.payload.encounter.diagnoses.length > 0, 'approved diagnosis missing');
  ok('doctor approval saved structured fields to encounter');

  const medication = structured.payload.structured_draft.medicationsMentioned[0];
  const rx = await request(`/dictations/${created.payload.id}/approve-prescription`, {
    method: 'POST',
    token: doctor,
    body: { ...medication, allergiesReviewed: true },
  });
  expect(rx.response.status === 201, `approve prescription failed: ${rx.response.status} ${JSON.stringify(rx.payload)}`);
  expect(rx.payload.prescription.drug === medication.drug, 'approved prescription drug mismatch');
  ok('doctor approval created prescription explicitly');

  const pool = new pg.Pool({ connectionString: DB });
  const migration = await pool.query(
    `SELECT 1 FROM public.schema_migration WHERE filename = '037_doctor_dictation_drafts.sql'`,
  );
  expect(migration.rows.length === 1, 'dictation migration not recorded');
  const audit = await pool.query(
    `SELECT action FROM luminary.audit_event
      WHERE subject_id = $1 AND action LIKE '%dictation%'
      ORDER BY occurred_at`,
    [encounter.payload.id],
  );
  expect(audit.rows.length >= 3, `dictation audit events missing: ${JSON.stringify(audit.rows)}`);
  await pool.end();
  ok('migration and audit trail recorded');

  console.log('Doctor dictation smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
