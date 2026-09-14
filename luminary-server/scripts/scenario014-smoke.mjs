import { randomUUID } from 'node:crypto';
import pg from 'pg';
import argon2 from 'argon2';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const DB = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';
const PRACTICE = process.env.PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || 'manager.test@h.co.zw';
const RECEPTION_EMAIL = process.env.RECEPTION_EMAIL || 'reception.test@h.co.zw';
const PASSWORD = process.env.PASSWORD || 'luminary';

const ok = (name, detail = '') => console.log(`ok - ${name}${detail ? `: ${detail}` : ''}`);

const linkedTables = [
  'agent_conversation',
  'appointment',
  'care_plan',
  'claim',
  'claim_authorisation',
  'claim_eligibility_result',
  'clinical_order',
  'collection_case',
  'encounter',
  'inbound_message',
  'intake_proposal',
  'invoice',
  'lab_result',
  'message',
  'patient_document',
  'prescription',
  'referral',
];

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

async function signIn(email, practiceId = PRACTICE) {
  const { response, payload } = await request('/auth/session', {
    method: 'POST',
    body: { practiceId, email, password: PASSWORD },
  });
  if (!response.ok) throw new Error(`sign-in failed for ${email}: ${response.status} ${JSON.stringify(payload)}`);
  return payload.token;
}

function patientBody(label, extras = {}) {
  const stamp = randomUUID().slice(0, 8);
  return {
    reference: `S014-${label}-${stamp}`,
    fullName: `Scenario ${label} Patient`,
    dateOfBirth: '1991-04-12',
    sex: 'Female',
    nationalId: null,
    phone: `077${Math.floor(1000000 + Math.random() * 8999999)}`,
    addressCity: 'Harare',
    emergencyName: 'Scenario Contact',
    emergencyRelation: 'Sibling',
    emergencyPhone: `071${Math.floor(1000000 + Math.random() * 8999999)}`,
    consentTreatment: true,
    consentComms: false,
    ...extras,
  };
}

async function createPatient(token, body, expected = 201) {
  const result = await request('/patients', { method: 'POST', token, body });
  if (result.response.status !== expected) {
    throw new Error(`patient create expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.payload)}`);
  }
  return result.payload;
}

async function countLinks(pool, patientId) {
  const counts = {};
  for (const table of linkedTables) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM luminary.${table} WHERE patient_id = $1`,
      [patientId],
    );
    counts[table] = Number(rows[0].count);
  }
  return counts;
}

async function main() {
  const managerToken = await signIn(MANAGER_EMAIL);
  const receptionToken = await signIn(RECEPTION_EMAIL);
  ok('authenticated live manager and receptionist accounts');
  const pool = new pg.Pool({ connectionString: DB });

  const unknownC = await createPatient(managerToken, patientBody('UnknownC'));
  const unknownD = await createPatient(managerToken, patientBody('UnknownD'));
  if (unknownC.id === unknownD.id || unknownC.national_id || unknownD.national_id) {
    throw new Error('unknown national ID patients did not persist as distinct NULL identities');
  }
  ok('two patients with unknown national ID coexist');

  const placeholderUnknown = await createPatient(managerToken, patientBody('PlaceholderUnknown', {
    nationalId: 'UNKNOWN',
  }));
  if (placeholderUnknown.national_id !== null) {
    throw new Error(`placeholder national ID was not stored as NULL: ${JSON.stringify(placeholderUnknown)}`);
  }
  ok('placeholder national ID input is stored as NULL');

  const knownId = `S014-${randomUUID().slice(0, 8)}-NID`;
  const known = await createPatient(managerToken, patientBody('Known', { nationalId: knownId }));
  const duplicate = await createPatient(
    managerToken,
    patientBody('KnownDup', { nationalId: knownId.replace('-', ' - ').toUpperCase() }),
    409,
  );
  if (duplicate.details?.kind !== 'exact_duplicate') {
    throw new Error(`known national ID duplicate was not classified as exact: ${JSON.stringify(duplicate)}`);
  }
  ok('known normalized national ID duplicate is blocked');

  const unauthorizedCorrection = await request(`/patients/${unknownC.id}/identity-corrections`, {
    method: 'POST',
    token: receptionToken,
    body: { nationalId: `S014-CORR-${randomUUID().slice(0, 6)}`, reason: 'Scenario 014 unauthorized check' },
  });
  if (unauthorizedCorrection.response.status !== 403) {
    throw new Error(`unauthorized correction returned ${unauthorizedCorrection.response.status}`);
  }
  ok('unauthorized strong identity correction fails closed');

  const correctedNationalId = `S014-CORR-${randomUUID().slice(0, 8)}`;
  const corrected = await request(`/patients/${unknownC.id}/identity-corrections`, {
    method: 'POST',
    token: managerToken,
    body: {
      nationalId: correctedNationalId,
      dateOfBirth: '1992-05-13',
      reason: 'Scenario 014 verified correction',
    },
  });
  if (!corrected.response.ok || corrected.payload.id !== unknownC.id
      || corrected.payload.date_of_birth !== '1992-05-13'
      || corrected.payload.national_id !== correctedNationalId) {
    throw new Error(`authorized correction failed: ${corrected.response.status} ${JSON.stringify(corrected.payload)}`);
  }
  ok('authorized national ID and DOB correction preserves patient id');

  const basePhone = `077${Math.floor(1000000 + Math.random() * 8999999)}`;
  const survivor = await createPatient(managerToken, patientBody('Survivor', {
    fullName: 'Scenario Merge Person',
    dateOfBirth: '1988-03-10',
    nationalId: `S014-SURV-${randomUUID().slice(0, 8)}`,
    phone: basePhone,
  }));
  const probable = await createPatient(managerToken, patientBody('Source', {
    fullName: 'Scenario Merge Person',
    dateOfBirth: '1988-03-10',
    nationalId: null,
    phone: basePhone,
  }), 409);
  if (probable.details?.kind !== 'probable_duplicate'
      || !probable.details.candidates?.some((candidate) => candidate.patientId === survivor.id)) {
    throw new Error(`probable duplicate warning missing survivor candidate: ${JSON.stringify(probable)}`);
  }
  ok('probable duplicate warning is surfaced without auto-merge');

  const source = await createPatient(managerToken, patientBody('Source', {
    fullName: 'Scenario Merge Person',
    dateOfBirth: '1988-03-10',
    nationalId: null,
    phone: basePhone,
    duplicateAcknowledged: true,
  }));
  ok('probable duplicate can be explicitly acknowledged');

  const sameNameDifferentPerson = await createPatient(managerToken, patientBody('FalsePositive', {
    fullName: 'Scenario Merge Person',
    dateOfBirth: '1977-09-09',
    nationalId: `S014-FALSE-${randomUUID().slice(0, 8)}`,
  }));
  if (!sameNameDifferentPerson.id) throw new Error('same-name false positive patient was not created');
  ok('same name alone does not force duplicate identity');

  await pool.query(
    `INSERT INTO luminary.message
       (practice_id, patient_id, channel, body, status)
     VALUES ($1, $2, 'sms', 'Scenario 014 merge message', 'queued')`,
    [PRACTICE, source.id],
  );
  const beforeSource = await countLinks(pool, source.id);
  const beforeSurvivor = await countLinks(pool, survivor.id);

  const merge = await request('/patients/merge', {
    method: 'POST',
    token: managerToken,
    body: {
      sourcePatientId: source.id,
      survivorPatientId: survivor.id,
      reason: 'Scenario 014 duplicate registration',
    },
  });
  if (!merge.response.ok || merge.payload.status !== 'merged') {
    throw new Error(`merge failed: ${merge.response.status} ${JSON.stringify(merge.payload)}`);
  }
  ok('patient merge completed transactionally');

  const afterSource = await countLinks(pool, source.id);
  const afterSurvivor = await countLinks(pool, survivor.id);
  for (const table of linkedTables) {
    if (afterSource[table] !== 0) throw new Error(`${table} still references source patient`);
    if (afterSurvivor[table] !== beforeSurvivor[table] + beforeSource[table]) {
      throw new Error(`${table} count did not reconcile`);
    }
  }
  ok('patient-linked table counts reconcile');

  const sourceLookup = await request(`/patients/${source.id}`, { token: managerToken });
  if (!sourceLookup.response.ok || sourceLookup.payload.patient?.merged_into_id !== survivor.id) {
    throw new Error(`source lookup does not expose merged state: ${sourceLookup.response.status} ${JSON.stringify(sourceLookup.payload)}`);
  }
  ok('old source lookup exposes canonical survivor');

  const oldReferenceSearch = await request('/patients', {
    token: managerToken,
    body: undefined,
  });
  const sourceReferenceSearch = await request(`/patients?search=${encodeURIComponent(source.reference)}`, {
    token: managerToken,
  });
  if (!sourceReferenceSearch.response.ok
      || !sourceReferenceSearch.payload.some((patient) => patient.id === survivor.id)
      || sourceReferenceSearch.payload.some((patient) => patient.id === source.id)) {
    throw new Error(`old source reference search did not resolve to canonical survivor: ${JSON.stringify(sourceReferenceSearch.payload)}`);
  }
  if (!oldReferenceSearch.response.ok) {
    throw new Error(`patient list failed after merge: ${oldReferenceSearch.response.status}`);
  }
  ok('old source reference search resolves to canonical survivor');

  const repeatMerge = await request('/patients/merge', {
    method: 'POST',
    token: managerToken,
    body: {
      sourcePatientId: source.id,
      survivorPatientId: survivor.id,
      reason: 'Scenario 014 repeat merge check',
    },
  });
  if (!repeatMerge.response.ok || repeatMerge.payload.status !== 'already_merged') {
    throw new Error(`repeat merge was not idempotent: ${repeatMerge.response.status} ${JSON.stringify(repeatMerge.payload)}`);
  }
  ok('repeat merge is idempotent');

  const loop = await request('/patients/merge', {
    method: 'POST',
    token: managerToken,
    body: {
      sourcePatientId: survivor.id,
      survivorPatientId: source.id,
      reason: 'Scenario 014 loop check',
    },
  });
  if (loop.response.status !== 409) throw new Error(`loop attempt returned ${loop.response.status}`);
  ok('merge loop attempt is rejected');

  const raceSurvivor = await createPatient(managerToken, patientBody('RaceSurvivor'));
  const raceOther = await createPatient(managerToken, patientBody('RaceOther'));
  const raceSource = await createPatient(managerToken, patientBody('RaceSource'));
  const raceResults = await Promise.all([
    request('/patients/merge', {
      method: 'POST',
      token: managerToken,
      body: {
        sourcePatientId: raceSource.id,
        survivorPatientId: raceSurvivor.id,
        reason: 'Scenario 014 concurrent merge winner',
      },
    }),
    request('/patients/merge', {
      method: 'POST',
      token: managerToken,
      body: {
        sourcePatientId: raceSource.id,
        survivorPatientId: raceOther.id,
        reason: 'Scenario 014 concurrent merge loser',
      },
    }),
  ]);
  const successfulRace = raceResults.filter((result) => result.response.ok && result.payload.status === 'merged');
  const rejectedRace = raceResults.filter((result) => result.response.status === 409);
  if (successfulRace.length !== 1 || rejectedRace.length !== 1) {
    throw new Error(`concurrent merge race did not produce one winner/one loser: ${JSON.stringify(raceResults.map((r) => ({ status: r.response.status, payload: r.payload })))}`);
  }
  ok('concurrent merge race has one winner and one controlled loser');

  const foreignPracticeId = randomUUID();
  const foreignUserId = randomUUID();
  const foreignPasswordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
  await pool.query(
    `INSERT INTO luminary.practice (id, name, short_name, city, primary_currency)
     VALUES ($1, 'Scenario 014 Foreign Practice', 'S014X', 'Harare', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [foreignPracticeId],
  );
  await pool.query(
    `INSERT INTO luminary.app_user
       (id, practice_id, email, full_name, display_name, role, password_hash, active)
     VALUES ($1, $2, $3, 'Scenario Foreign Manager', 'Foreign Manager', 'manager', $4, true)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true, deleted_at = NULL`,
    [foreignUserId, foreignPracticeId, `manager-${foreignPracticeId}@scenario014.test`, foreignPasswordHash],
  );
  const foreignToken = await signIn(`manager-${foreignPracticeId}@scenario014.test`, foreignPracticeId);
  const foreignPatient = await createPatient(foreignToken, patientBody('ForeignTenant'));
  const crossTenantMerge = await request('/patients/merge', {
    method: 'POST',
    token: managerToken,
    body: {
      sourcePatientId: foreignPatient.id,
      survivorPatientId: survivor.id,
      reason: 'Scenario 014 cross tenant rejection',
    },
  });
  if (![404, 409].includes(crossTenantMerge.response.status)) {
    throw new Error(`cross-tenant merge did not fail closed: ${crossTenantMerge.response.status}`);
  }
  ok('cross-tenant merge fails closed');

  const audit = await pool.query(
    `SELECT action, subject_id, detail
       FROM luminary.audit_event
      WHERE action IN ('Corrected patient identity', 'Merged patient identity')
        AND subject_id = ANY($1::uuid[])
      ORDER BY occurred_at DESC`,
    [[unknownC.id, survivor.id]],
  );
  await pool.end();
  if (!audit.rows.some((row) => row.action === 'Corrected patient identity')) {
    throw new Error('identity correction audit event missing');
  }
  if (!audit.rows.some((row) => row.action === 'Merged patient identity')) {
    throw new Error('merge audit event missing');
  }
  ok('identity correction and merge audit events persisted');

  console.log('Scenario 014 smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
