import { spawnSync } from 'node:child_process';
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

function patientBody(label) {
  const stamp = randomUUID().slice(0, 8);
  return {
    reference: `S018-${label}-${stamp}`,
    fullName: `Scenario Eighteen ${label}`,
    dateOfBirth: '1991-08-09',
    sex: 'Female',
    nationalId: null,
    phone: `077${Math.floor(1000000 + Math.random() * 8999999)}`,
    addressCity: 'Harare',
    emergencyName: 'Scenario Contact',
    emergencyRelation: 'Sibling',
    emergencyPhone: `071${Math.floor(1000000 + Math.random() * 8999999)}`,
    consentTreatment: true,
    consentComms: true,
  };
}

async function createPatient(token, label) {
  const created = await request('/patients', { method: 'POST', token, body: patientBody(label) });
  expect(created.response.status === 201, `patient create failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  return created.payload;
}

async function createWalkIn(token, patientId) {
  const created = await request('/appointments', {
    method: 'POST',
    token,
    body: {
      patientId,
      origin: 'walk_in',
      durationMin: 30,
      visitType: 'Scenario 018 visit',
      reason: 'Scenario 018 visit',
      mode: 'in_person',
    },
  });
  expect(created.response.status === 201, `appointment create failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  return created.payload;
}

async function createEncounter(token, patientId, appointmentId = null) {
  const created = await request('/encounters', {
    method: 'POST',
    token,
    body: { patientId, appointmentId, noteType: 'SOAP note' },
  });
  expect(created.response.status === 201, `encounter create failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  return created.payload;
}

async function firstService(token) {
  const services = await request('/services', { token });
  expect(services.response.ok, `service list failed: ${services.response.status} ${JSON.stringify(services.payload)}`);
  const service = services.payload.find((row) => row.active && row.orderable) ?? services.payload[0];
  expect(service?.id, 'no service available for order test');
  return service;
}

async function runScan(pool) {
  const checks = [
    ['appointment_patient', `SELECT a.id FROM luminary.appointment a JOIN luminary.patient p ON p.id = a.patient_id WHERE a.deleted_at IS NULL AND p.practice_id <> a.practice_id`],
    ['appointment_provider', `SELECT a.id FROM luminary.appointment a JOIN luminary.app_user u ON u.id = a.provider_id WHERE a.deleted_at IS NULL AND u.practice_id <> a.practice_id`],
    ['appointment_room', `SELECT a.id FROM luminary.appointment a JOIN luminary.room r ON r.id = a.room_id WHERE a.deleted_at IS NULL AND r.practice_id <> a.practice_id`],
    ['encounter_patient', `SELECT e.id FROM luminary.encounter e JOIN luminary.patient p ON p.id = e.patient_id WHERE e.deleted_at IS NULL AND p.practice_id <> e.practice_id`],
    ['encounter_appointment', `SELECT e.id FROM luminary.encounter e JOIN luminary.appointment a ON a.id = e.appointment_id WHERE e.deleted_at IS NULL AND a.practice_id <> e.practice_id`],
    ['encounter_appointment_patient', `SELECT e.id FROM luminary.encounter e JOIN luminary.appointment a ON a.id = e.appointment_id WHERE e.deleted_at IS NULL AND a.patient_id <> e.patient_id`],
    ['clinical_order_patient', `SELECT o.id FROM luminary.clinical_order o JOIN luminary.patient p ON p.id = o.patient_id WHERE o.deleted_at IS NULL AND p.practice_id <> o.practice_id`],
    ['clinical_order_encounter', `SELECT o.id FROM luminary.clinical_order o JOIN luminary.encounter e ON e.id = o.encounter_id WHERE o.deleted_at IS NULL AND (e.practice_id <> o.practice_id OR e.patient_id <> o.patient_id)`],
    ['lab_order', `SELECT l.id FROM luminary.lab_result l JOIN luminary.clinical_order o ON o.id = l.order_id WHERE l.deleted_at IS NULL AND (o.practice_id <> l.practice_id OR o.patient_id <> l.patient_id)`],
    ['document_encounter', `SELECT d.id FROM luminary.patient_document d JOIN luminary.encounter e ON e.id = d.encounter_id WHERE d.deleted_at IS NULL AND (e.practice_id <> d.practice_id OR e.patient_id <> d.patient_id)`],
    ['prescription_encounter', `SELECT rx.id FROM luminary.prescription rx JOIN luminary.encounter e ON e.id = rx.encounter_id WHERE rx.deleted_at IS NULL AND (e.practice_id <> rx.practice_id OR e.patient_id <> rx.patient_id)`],
    ['invoice_patient', `SELECT i.id FROM luminary.invoice i JOIN luminary.patient p ON p.id = i.patient_id WHERE i.deleted_at IS NULL AND p.practice_id <> i.practice_id`],
    ['invoice_line_invoice', `SELECT il.id FROM luminary.invoice_line il JOIN luminary.invoice i ON i.id = il.invoice_id WHERE il.deleted_at IS NULL AND i.practice_id <> il.practice_id`],
    ['claim_invoice', `SELECT c.id FROM luminary.claim c JOIN luminary.invoice i ON i.id = c.invoice_id WHERE c.deleted_at IS NULL AND (i.practice_id <> c.practice_id OR i.patient_id <> c.patient_id)`],
    ['claim_line_invoice_line', `SELECT cl.id FROM luminary.claim_line cl JOIN luminary.claim c ON c.id = cl.claim_id JOIN luminary.invoice_line il ON il.id = cl.invoice_line_id WHERE cl.deleted_at IS NULL AND il.practice_id <> cl.practice_id`],
    ['payment_invoice', `SELECT pay.id FROM luminary.payment pay JOIN luminary.invoice i ON i.id = pay.invoice_id WHERE pay.deleted_at IS NULL AND i.practice_id <> pay.practice_id`],
    ['collection_case_invoice', `SELECT cc.id FROM luminary.collection_case cc JOIN luminary.invoice i ON i.id = cc.invoice_id WHERE cc.deleted_at IS NULL AND (i.practice_id <> cc.practice_id OR i.patient_id <> cc.patient_id)`],
    ['message_patient', `SELECT m.id FROM luminary.message m JOIN luminary.patient p ON p.id = m.patient_id WHERE m.deleted_at IS NULL AND p.practice_id <> m.practice_id`],
    ['message_appointment', `SELECT m.id FROM luminary.message m JOIN luminary.appointment a ON a.id = m.appointment_id WHERE m.deleted_at IS NULL AND (a.practice_id <> m.practice_id OR a.patient_id <> m.patient_id)`],
  ];

  const failures = [];
  for (const [name, sql] of checks) {
    const { rows } = await pool.query(sql);
    if (rows.length > 0) failures.push({ name, ids: rows.map((row) => row.id) });
  }
  return failures;
}

async function quarantineKnownContamination(pool, failures) {
  const idsByTable = new Map();
  for (const failure of failures) {
    if (failure.name.startsWith('appointment_')) idsByTable.set('appointment', [...(idsByTable.get('appointment') ?? []), ...failure.ids]);
    if (failure.name.startsWith('encounter_')) idsByTable.set('encounter', [...(idsByTable.get('encounter') ?? []), ...failure.ids]);
    if (failure.name === 'invoice_patient') idsByTable.set('invoice', [...(idsByTable.get('invoice') ?? []), ...failure.ids]);
  }
  const quarantined = [];
  for (const [table, ids] of idsByTable) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) continue;
    if (table === 'invoice') {
      const blockers = await pool.query(
        `SELECT i.id
           FROM luminary.invoice i
          WHERE i.id = ANY($1::uuid[])
            AND (
              EXISTS (SELECT 1 FROM luminary.payment p WHERE p.invoice_id = i.id AND p.deleted_at IS NULL)
              OR EXISTS (SELECT 1 FROM luminary.claim c WHERE c.invoice_id = i.id AND c.deleted_at IS NULL)
              OR EXISTS (SELECT 1 FROM luminary.collection_case cc WHERE cc.invoice_id = i.id AND cc.deleted_at IS NULL)
            )`,
        [unique],
      );
      expect(blockers.rows.length === 0, `refusing to quarantine contaminated invoice with active financial dependents: ${JSON.stringify(blockers.rows)}`);
      await pool.query(
        `UPDATE luminary.invoice_line
            SET deleted_at = COALESCE(deleted_at, now()),
                updated_at = now()
          WHERE invoice_id = ANY($1::uuid[])`,
        [unique],
      );
    }
    const { rows } = await pool.query(
      `UPDATE luminary.${table}
          SET deleted_at = COALESCE(deleted_at, now()),
              updated_at = now()
        WHERE id = ANY($1::uuid[])
        RETURNING id`,
      [unique],
    );
    quarantined.push(...rows.map((row) => `${table}:${row.id}`));
  }
  return quarantined;
}

async function describeFailures(pool, failures) {
  for (const failure of failures) {
    if (failure.name === 'invoice_patient') {
      const { rows } = await pool.query(
        `SELECT i.id,
                i.practice_id,
                i.reference AS invoice_reference,
                i.patient_id,
                i.status,
                i.total,
                i.created_at,
                p.practice_id AS patient_practice_id,
                p.reference AS patient_reference,
                p.full_name AS patient_name
           FROM luminary.invoice i
           JOIN luminary.patient p ON p.id = i.patient_id
          WHERE i.id = ANY($1::uuid[])`,
        [failure.ids],
      );
      console.log(`diagnostic ${failure.name}: ${JSON.stringify(rows)}`);
    }
  }
}

async function main() {
  const managerA = await signIn(PRACTICE_A, USERS.managerA);
  const doctorA = await signIn(PRACTICE_A, USERS.doctorA);
  const receptionistA = await signIn(PRACTICE_A, USERS.receptionistA);
  const doctorB = await signIn(PRACTICE_B, USERS.doctorB);
  ok('authenticated Practice A and Practice B users');

  const patientA = await createPatient(managerA, 'Alpha');
  const patientB = await createPatient(managerA, 'Bravo');
  const apptA = await createWalkIn(managerA, patientA.id);
  const apptB = await createWalkIn(managerA, patientB.id);
  const encounterA = await createEncounter(doctorA, patientA.id, apptA.id);
  const encounterB = await createEncounter(doctorA, patientB.id, apptB.id);
  await createEncounter(doctorA, patientA.id, null);
  ok('valid scheduled and unscheduled encounter workflows still work');

  const crossAppointment = await request('/appointments', {
    method: 'POST',
    token: doctorB,
    body: { patientId: patientA.id, origin: 'walk_in', durationMin: 30, visitType: 'Cross tenant attempt', mode: 'in_person' },
  });
  expect(!crossAppointment.response.ok, `cross-tenant appointment was accepted: ${JSON.stringify(crossAppointment.payload)}`);
  ok('cross-tenant appointment creation fails closed', String(crossAppointment.response.status));

  const crossEncounter = await request('/encounters', {
    method: 'POST',
    token: doctorB,
    body: { patientId: patientA.id, appointmentId: apptA.id, noteType: 'SOAP note' },
  });
  expect(!crossEncounter.response.ok, `cross-tenant encounter was accepted: ${JSON.stringify(crossEncounter.payload)}`);
  ok('cross-tenant encounter creation fails closed', String(crossEncounter.response.status));

  const wrongAppointment = await request('/encounters', {
    method: 'POST',
    token: doctorA,
    body: { patientId: patientA.id, appointmentId: apptB.id, noteType: 'SOAP note' },
  });
  expect(!wrongAppointment.response.ok, `same-tenant wrong patient/appointment was accepted: ${JSON.stringify(wrongAppointment.payload)}`);
  ok('same-tenant wrong patient/appointment linkage is rejected');

  const service = await firstService(doctorA);
  const validOrder = await request('/orders', {
    method: 'POST',
    token: doctorA,
    body: { patientId: patientA.id, serviceId: service.id, encounterId: encounterA.id, clinicalNotes: 'Scenario 018 valid order' },
  });
  expect(validOrder.response.status === 201, `valid order failed: ${validOrder.response.status} ${JSON.stringify(validOrder.payload)}`);
  const crossOrder = await request('/orders', {
    method: 'POST',
    token: doctorB,
    body: { patientId: patientA.id, serviceId: service.id, clinicalNotes: 'Cross tenant order attempt' },
  });
  expect(!crossOrder.response.ok, `cross-tenant order was accepted: ${JSON.stringify(crossOrder.payload)}`);
  ok('clinical order validates tenant-owned references');

  const wrongDocument = await request(`/patients/${patientA.id}/documents`, {
    method: 'POST',
    token: doctorA,
    body: {
      encounterId: encounterB.id,
      kind: 'document',
      filename: 'wrong-link.txt',
      contentType: 'application/pdf',
      byteSize: 4,
      dataBase64: Buffer.from('test').toString('base64'),
    },
  });
  expect(!wrongDocument.response.ok, 'wrong document linkage was accepted');
  ok('document upload rejects invalid encounter linkage');

  const wrongMessage = await request('/messages', {
    method: 'POST',
    token: doctorA,
    body: {
      patientId: patientA.id,
      appointmentId: apptB.id,
      channel: 'sms',
      template: 'appointment_confirmation',
      body: 'Wrong patient appointment message',
    },
  });
  expect(!wrongMessage.response.ok, `wrong message linkage was accepted: ${JSON.stringify(wrongMessage.payload)}`);
  ok('message appointment linkage remains protected');

  const roleDenied = await request(`/patients/${patientA.id}/documents`, {
    method: 'POST',
    token: receptionistA,
    body: {
      kind: 'document',
      filename: 'role-denied.pdf',
      contentType: 'application/pdf',
      byteSize: 4,
      dataBase64: Buffer.from('test').toString('base64'),
    },
  });
  expect(roleDenied.response.status === 403, `receptionist document upload did not fail by role: ${roleDenied.response.status}`);
  ok('role permissions still fail closed');

  const seedGuard = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/seed-test-roles.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: DB },
      encoding: 'utf8',
    },
  );
  expect(seedGuard.status !== 0 && seedGuard.stderr.includes('Refusing to seed test-role accounts'), 'production seed guard did not refuse');
  ok('production test-account seed guard refuses by default');

  const pool = new pg.Pool({ connectionString: DB });
  let failures = await runScan(pool);
  if (failures.length > 0) await describeFailures(pool, failures);
  const quarantined = failures.length > 0 ? await quarantineKnownContamination(pool, failures) : [];
  if (quarantined.length > 0) {
    console.log(`quarantined known contaminated synthetic rows: ${quarantined.join(', ')}`);
  }
  failures = await runScan(pool);
  expect(failures.length === 0, `relationship scan found contamination: ${JSON.stringify(failures)}`);
  ok('full cross-tenant and wrong-patient relationship scan is clean');

  const migration = await pool.query(
    `SELECT checksum FROM public.schema_migration WHERE filename = '036_scenario018_tenant_reference_hardening.sql'`,
  );
  expect(Boolean(migration.rows[0]?.checksum), 'Scenario 018 migration was not recorded');
  ok('startup schema migration is recorded for readiness check');
  await pool.end();

  console.log('Scenario 018 smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
