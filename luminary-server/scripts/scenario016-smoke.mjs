import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { syncService, SNAPSHOT_ORDER } from '../src/modules/sync/sync.service.js';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const DB = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';
const PRACTICE = process.env.PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || 'manager.test@h.co.zw';
const DOCTOR_EMAIL = process.env.DOCTOR_EMAIL || 'doctor.test@h.co.zw';
const PASSWORD = process.env.PASSWORD || process.env.LUMINARY_TEST_PASSWORD || 'luminary';

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

async function signIn(email) {
  const { response, payload } = await request('/auth/session', {
    method: 'POST',
    body: { practiceId: PRACTICE, email, password: PASSWORD },
  });
  if (!response.ok) throw new Error(`sign-in failed for ${email}: ${response.status} ${JSON.stringify(payload)}`);
  return payload.token;
}

function patientBody(label) {
  const stamp = randomUUID().slice(0, 8);
  return {
    reference: `S016-${label}-${stamp}`,
    fullName: `Scenario Sixteen ${label}`,
    dateOfBirth: '1989-06-07',
    sex: 'Female',
    nationalId: null,
    phone: `077${Math.floor(1000000 + Math.random() * 8999999)}`,
    addressCity: 'Harare',
    emergencyName: 'Scenario Contact',
    emergencyRelation: 'Sibling',
    emergencyPhone: `071${Math.floor(1000000 + Math.random() * 8999999)}`,
    consentTreatment: true,
    consentComms: false,
  };
}

async function createSignedEncounter(managerToken, doctorToken) {
  const patient = await request('/patients', {
    method: 'POST',
    token: managerToken,
    body: patientBody('Signed'),
  });
  expect(patient.response.status === 201, `patient create failed: ${patient.response.status} ${JSON.stringify(patient.payload)}`);

  const draft = await request('/encounters', {
    method: 'POST',
    token: doctorToken,
    body: { patientId: patient.payload.id, noteType: 'SOAP note' },
  });
  expect(draft.response.status === 201, `draft create failed: ${draft.response.status} ${JSON.stringify(draft.payload)}`);

  const saved = await request(`/encounters/${draft.payload.id}`, {
    method: 'PUT',
    token: doctorToken,
    body: {
      subjective: 'Scenario 016 signed note subjective',
      objective: 'Scenario 016 signed note objective',
      assessment: 'Scenario 016 signed note assessment',
      plan: 'Scenario 016 signed note plan',
      diagnoses: [{ code: 'Z00.0', label: 'General examination' }],
    },
  });
  expect(saved.response.ok, `draft save failed: ${saved.response.status} ${JSON.stringify(saved.payload)}`);

  const signed = await request(`/encounters/${draft.payload.id}/signature`, {
    method: 'POST',
    token: doctorToken,
    body: {},
  });
  expect(signed.response.status === 201, `sign failed: ${signed.response.status} ${JSON.stringify(signed.payload)}`);
  return { patient: patient.payload, encounter: signed.payload };
}

async function withTenant(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('luminary.practice_id', $1, true),
              set_config('luminary.user_id', $2, true),
              set_config('luminary.node', $3, true)`,
      [PRACTICE, '', 'scenario016-smoke'],
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  expect(SNAPSHOT_ORDER.includes('payer'), 'payer is missing from snapshot order');
  expect(SNAPSHOT_ORDER.indexOf('payer') < SNAPSHOT_ORDER.indexOf('scheme'), 'payer must snapshot before scheme');
  ok('payer is in snapshot order before scheme');

  const managerToken = await signIn(MANAGER_EMAIL);
  const doctorToken = await signIn(DOCTOR_EMAIL);
  ok('authenticated manager and doctor accounts');

  const pool = new pg.Pool({ connectionString: DB });
  const { rows: users } = await pool.query(
    `SELECT id FROM luminary.app_user
      WHERE practice_id = $1 AND email = $2 AND deleted_at IS NULL`,
    [PRACTICE, DOCTOR_EMAIL],
  );
  const doctorId = users[0]?.id;
  expect(doctorId, 'doctor test account missing');

  const signed = await createSignedEncounter(managerToken, doctorToken);
  const original = await pool.query(
    `SELECT * FROM luminary.encounter WHERE id = $1`,
    [signed.encounter.id],
  );
  const staleDraft = {
    ...original.rows[0],
    status: 'draft',
    subjective: 'stale draft attempted overwrite',
    signed_by: null,
    signed_at: null,
    updated_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const applyResult = await withTenant(pool, (client) =>
    syncService.apply(client, 'cloud', [{
      seq: 999001,
      practice_id: PRACTICE,
      table_name: 'encounter',
      row_id: signed.encounter.id,
      operation: 'update',
      payload: staleDraft,
      origin_node: 'scenario016-peer',
      occurred_at: new Date().toISOString(),
    }]),
  );
  expect(applyResult.conflicts === 1, `signed encounter overwrite was not routed to conflict: ${JSON.stringify(applyResult)}`);
  const afterSigned = await pool.query(
    `SELECT status, subjective FROM luminary.encounter WHERE id = $1`,
    [signed.encounter.id],
  );
  expect(afterSigned.rows[0].status === 'signed', 'signed encounter status was overwritten');
  expect(afterSigned.rows[0].subjective === 'Scenario 016 signed note subjective', 'signed encounter body was overwritten');
  ok('signed encounter is protected from stale draft sync overwrite');

  const missingDocId = randomUUID();
  await pool.query(
    `INSERT INTO luminary.patient_document
       (id, practice_id, patient_id, uploaded_by, kind, filename, content_type,
        byte_size, storage_key, checksum)
     VALUES ($1, $2, $3, $4, 'document', 'missing-bytes.pdf',
             'application/pdf', 12, $5, repeat('0', 64))`,
    [
      missingDocId,
      PRACTICE,
      signed.patient.id,
      doctorId,
      `${PRACTICE}/${signed.patient.id}/${randomUUID()}-missing-bytes.pdf`,
    ],
  );
  const missingDownload = await request(`/documents/${missingDocId}/download`, { token: doctorToken });
  expect(missingDownload.response.status === 409, `missing bytes did not return controlled 409: ${missingDownload.response.status}`);
  const health = await request('/health');
  expect(health.response.ok, 'server health failed after missing-byte download');
  ok('missing document bytes return controlled error and server survives');

  await pool.query(
    `INSERT INTO luminary.sync_peer
       (practice_id, peer_node, last_error, last_failure_at, consecutive_failures)
     VALUES ($1, 'cloud', 'scenario016 poison row', now(), 3)
     ON CONFLICT (practice_id, peer_node)
     DO UPDATE SET last_error = EXCLUDED.last_error,
                   last_failure_at = EXCLUDED.last_failure_at,
                   consecutive_failures = EXCLUDED.consecutive_failures`,
    [PRACTICE],
  );
  const status = await request('/sync/status', { token: managerToken });
  expect(status.response.ok, `sync status failed: ${status.response.status}`);
  expect(status.payload.state === 'stuck', `sync status did not report stuck: ${JSON.stringify(status.payload)}`);
  expect(status.payload.lastError === 'scenario016 poison row', 'sync status did not expose last error');
  await pool.query(
    `UPDATE luminary.sync_peer
        SET last_error = NULL, last_failure_at = NULL, consecutive_failures = 0
      WHERE practice_id = $1 AND peer_node = 'cloud'`,
    [PRACTICE],
  );
  ok('sync status distinguishes stuck from ordinary behind');

  await pool.end();
  console.log('Scenario 016 smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
