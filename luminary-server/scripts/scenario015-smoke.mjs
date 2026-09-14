import { randomUUID } from 'node:crypto';
import pg from 'pg';
import argon2 from 'argon2';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const DB = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';
const PRACTICE = process.env.PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || 'manager.test@h.co.zw';
const RECEPTION_EMAIL = process.env.RECEPTION_EMAIL || 'reception.test@h.co.zw';
const NURSE_EMAIL = process.env.NURSE_EMAIL || 'nurse.test@h.co.zw';
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

async function signIn(email, practiceId = PRACTICE) {
  const { response, payload } = await request('/auth/session', {
    method: 'POST',
    body: { practiceId, email, password: PASSWORD },
  });
  if (!response.ok) throw new Error(`sign-in failed for ${email}: ${response.status} ${JSON.stringify(payload)}`);
  return payload.token;
}

function patientBody(label) {
  const stamp = randomUUID().slice(0, 8);
  return {
    reference: `S015-${label}-${stamp}`,
    fullName: `Scenario Fifteen ${label}`,
    dateOfBirth: '1990-02-03',
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

async function createPatient(token, label, practiceId = PRACTICE) {
  const { response, payload } = await request('/patients', {
    method: 'POST',
    token,
    body: patientBody(label),
  });
  if (!response.ok) {
    throw new Error(`patient create failed for ${practiceId}: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function postStatus(token, appointmentId, status, reason) {
  return request(`/appointments/${appointmentId}/status`, {
    method: 'POST',
    token,
    body: { status, reason },
  });
}

async function userId(pool, email, practiceId = PRACTICE) {
  const { rows } = await pool.query(
    `SELECT id FROM luminary.app_user
      WHERE practice_id = $1 AND email = $2 AND active = true AND deleted_at IS NULL`,
    [practiceId, email],
  );
  if (!rows[0]) throw new Error(`active test account missing: ${email}`);
  return rows[0].id;
}

async function firstFreeSlot(token, doctorId) {
  const base = new Date();
  for (let offset = 0; offset < 21; offset += 1) {
    const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offset));
    const isoDay = day.toISOString().slice(0, 10);
    const { response, payload } = await request(
      `/appointments/availability?providerId=${doctorId}&day=${isoDay}&durationMin=30`,
      { token },
    );
    if (!response.ok) continue;
    const slot = payload.find((item) => item.free);
    if (slot) return slot.slot_start;
  }
  throw new Error('no free provider slot found in the next 21 days');
}

async function nextClosedDay(pool) {
  const { rows } = await pool.query(
    `SELECT open_days FROM luminary.practice_settings WHERE practice_id = $1`,
    [PRACTICE],
  );
  const openDays = new Set(rows[0]?.open_days ?? []);
  if (openDays.size >= 7) return null;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const base = new Date();
  for (let offset = 0; offset < 21; offset += 1) {
    const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offset));
    if (!openDays.has(dayNames[candidate.getUTCDay()])) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  return null;
}

async function createForeignPractice(pool) {
  const practiceId = randomUUID();
  const doctorId = randomUUID();
  const patientId = randomUUID();
  const appointmentId = randomUUID();
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
  const email = `doctor-${practiceId}@scenario015.test`;
  await pool.query(
    `INSERT INTO luminary.practice (id, name, short_name, city, primary_currency)
     VALUES ($1, 'Scenario 015 Foreign Practice', 'S015X', 'Harare', 'USD')`,
    [practiceId],
  );
  await pool.query(
    `INSERT INTO luminary.practice_settings (practice_id, timezone)
     VALUES ($1, 'Africa/Harare')`,
    [practiceId],
  );
  await pool.query(
    `INSERT INTO luminary.app_user
       (id, practice_id, email, full_name, display_name, role, is_provider, password_hash, active, registration_expires)
     VALUES ($1, $2, $3, 'Scenario Foreign Doctor', 'Foreign Doctor', 'doctor', true, $4, true, current_date + 365)`,
    [doctorId, practiceId, email, hash],
  );
  await pool.query(
    `INSERT INTO luminary.patient
       (id, practice_id, reference, full_name, date_of_birth, sex, phone, address_city,
        emergency_name, emergency_relation, emergency_phone, consent_treatment)
     VALUES ($1, $2, 'S015-FOREIGN', 'Scenario Fifteen Foreign', '1990-02-03',
             'Female', '0771234567', 'Harare', 'Scenario Contact', 'Sibling', '0711234567', true)`,
    [patientId, practiceId],
  );
  await pool.query(
    `INSERT INTO luminary.appointment
       (id, practice_id, patient_id, provider_id, starts_at, duration_min, visit_type)
     VALUES ($1, $2, $3, $4, now() + interval '3 days', 30, 'Foreign visit')`,
    [appointmentId, practiceId, patientId, doctorId],
  );
  return { practiceId, email, patientId, appointmentId };
}

async function main() {
  const pool = new pg.Pool({ connectionString: DB });
  const startMarker = new Date().toISOString();

  const managerToken = await signIn(MANAGER_EMAIL);
  const receptionToken = await signIn(RECEPTION_EMAIL);
  const nurseToken = await signIn(NURSE_EMAIL);
  const doctorToken = await signIn(DOCTOR_EMAIL);
  ok('authenticated manager, reception, nurse, and doctor accounts');

  const doctorId = await userId(pool, DOCTOR_EMAIL);
  const patientA = await createPatient(managerToken, 'Alpha');
  const patientB = await createPatient(managerToken, 'Bravo');

  const slot = await firstFreeSlot(managerToken, doctorId);
  const scheduled = await request('/appointments', {
    method: 'POST',
    token: managerToken,
    body: {
      patientId: patientB.id,
      providerId: doctorId,
      startsAt: slot,
      durationMin: 30,
      visitType: 'Scenario 015 scheduled visit',
      origin: 'scheduled',
    },
  });
  expect(scheduled.response.status === 201, `scheduled create failed: ${scheduled.response.status} ${JSON.stringify(scheduled.payload)}`);
  expect(scheduled.payload.arrived_at === null, 'scheduled appointment should not have arrived_at before check-in');
  ok('scheduled visit created without premature arrival timestamp');

  const mismatch = await request('/encounters', {
    method: 'POST',
    token: doctorToken,
    body: { patientId: patientA.id, appointmentId: scheduled.payload.id, noteType: 'SOAP note' },
  });
  expect(mismatch.response.status === 400, `mismatched encounter link did not fail as bad request: ${mismatch.response.status}`);
  ok('same-practice patient/appointment mismatch fails closed');

  const validEncounter = await request('/encounters', {
    method: 'POST',
    token: doctorToken,
    body: { patientId: patientB.id, appointmentId: scheduled.payload.id, noteType: 'SOAP note' },
  });
  expect(validEncounter.response.status === 201, `valid encounter link failed: ${validEncounter.response.status} ${JSON.stringify(validEncounter.payload)}`);
  ok('valid encounter links to the matching appointment and patient');

  const unscheduledEncounter = await request('/encounters', {
    method: 'POST',
    token: doctorToken,
    body: { patientId: patientA.id, noteType: 'SOAP note' },
  });
  expect(unscheduledEncounter.response.status === 201, `unscheduled encounter failed: ${unscheduledEncounter.response.status}`);
  ok('unscheduled encounter remains supported');

  const walkIn = await request('/appointments', {
    method: 'POST',
    token: receptionToken,
    body: {
      patientId: patientA.id,
      durationMin: 30,
      visitType: 'Scenario 015 walk-in',
      origin: 'walk_in',
    },
  });
  expect(walkIn.response.status === 201, `walk-in create failed: ${walkIn.response.status} ${JSON.stringify(walkIn.payload)}`);
  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 60 * 60_000).toISOString();
  const dayList = await request(`/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
    token: receptionToken,
  });
  expect(dayList.response.ok, `appointment list failed: ${dayList.response.status}`);
  expect(dayList.payload.some((row) => row.id === walkIn.payload.id), 'walk-in missing from operational-time appointment list');
  ok('walk-ins appear in date-range appointment lists by arrived_at');

  const checkedIn = await postStatus(receptionToken, scheduled.payload.id, 'checked_in');
  expect(checkedIn.response.ok, `check-in failed: ${checkedIn.response.status} ${JSON.stringify(checkedIn.payload)}`);
  expect(checkedIn.payload.arrived_at, 'check-in did not stamp arrived_at');
  const arrivedAt = checkedIn.payload.arrived_at;
  ok('scheduled check-in stamps arrived_at once');

  const triage = await postStatus(nurseToken, scheduled.payload.id, 'in_triage');
  expect(triage.response.ok, `nurse triage transition failed: ${triage.response.status} ${JSON.stringify(triage.payload)}`);
  expect(triage.payload.arrived_at === arrivedAt, 'arrived_at changed after triage transition');
  const ready = await postStatus(nurseToken, scheduled.payload.id, 'waiting_for_provider');
  expect(ready.response.ok, `ready-for-provider transition failed: ${ready.response.status}`);
  expect(ready.payload.arrived_at === arrivedAt, 'arrived_at changed after ready transition');

  const receptionConsult = await postStatus(receptionToken, scheduled.payload.id, 'in_consultation');
  expect(receptionConsult.response.status === 403, `reception was allowed to start consultation: ${receptionConsult.response.status}`);
  ok('reception cannot initiate consultation');

  const inConsultation = await postStatus(doctorToken, scheduled.payload.id, 'in_consultation');
  expect(inConsultation.response.ok, `assigned doctor could not start consultation: ${inConsultation.response.status} ${JSON.stringify(inConsultation.payload)}`);
  const completed = await postStatus(doctorToken, scheduled.payload.id, 'completed');
  expect(completed.response.ok, `assigned doctor could not complete consultation: ${completed.response.status} ${JSON.stringify(completed.payload)}`);
  ok('assigned doctor can start and complete own visit');

  const history = await request(`/appointments/${scheduled.payload.id}/status-history`, { token: managerToken });
  expect(history.response.ok, `status history failed: ${history.response.status} ${JSON.stringify(history.payload)}`);
  const historyTransitions = history.payload.map((row) => `${row.from_status ?? 'new'}>${row.to_status}`);
  for (const transition of [
    'new>booked',
    'booked>checked_in',
    'checked_in>in_triage',
    'in_triage>waiting_for_provider',
    'waiting_for_provider>in_consultation',
    'in_consultation>completed',
  ]) {
    expect(historyTransitions.includes(transition), `status history missing ${transition}: ${historyTransitions.join(', ')}`);
  }
  ok('appointment status history is append-only and retrievable');

  const closedDay = await nextClosedDay(pool);
  if (closedDay) {
    const closedBooking = await request('/appointments', {
      method: 'POST',
      token: managerToken,
      body: {
        patientId: patientA.id,
        providerId: doctorId,
        startsAt: `${closedDay}T09:00:00+02:00`,
        durationMin: 30,
        visitType: 'Scenario 015 closed-day booking',
        origin: 'scheduled',
      },
    });
    expect(closedBooking.response.status === 409, `closed-day booking was not rejected: ${closedBooking.response.status}`);
    ok('closed-day booking is rejected', closedDay);

    const rescheduleSlot = await firstFreeSlot(managerToken, doctorId);
    const reschedulable = await request('/appointments', {
      method: 'POST',
      token: managerToken,
      body: {
        patientId: patientA.id,
        providerId: doctorId,
        startsAt: rescheduleSlot,
        durationMin: 30,
        visitType: 'Scenario 015 reschedule policy',
        origin: 'scheduled',
      },
    });
    expect(reschedulable.response.status === 201, `reschedulable appointment create failed: ${reschedulable.response.status}`);
    const closedReschedule = await request(`/appointments/${reschedulable.payload.id}`, {
      method: 'PATCH',
      token: managerToken,
      body: { startsAt: `${closedDay}T09:30:00+02:00` },
    });
    expect(closedReschedule.response.status === 409, `closed-day reschedule was not rejected: ${closedReschedule.response.status}`);
    ok('closed-day reschedule is rejected', closedDay);
  } else {
    ok('closed-day booking/reschedule policy not exercised because every weekday is configured open');
  }

  const cancelledSlot = await firstFreeSlot(managerToken, doctorId);
  const cancellable = await request('/appointments', {
    method: 'POST',
    token: managerToken,
    body: {
      patientId: patientA.id,
      providerId: doctorId,
      startsAt: cancelledSlot,
      durationMin: 30,
      visitType: 'Scenario 015 cancellation',
      origin: 'scheduled',
    },
  });
  expect(cancellable.response.status === 201, `cancellable appointment create failed: ${cancellable.response.status}`);
  const cancelled = await postStatus(receptionToken, cancellable.payload.id, 'cancelled', 'Patient called to cancel');
  expect(cancelled.response.ok, `cancel transition failed: ${cancelled.response.status}`);
  expect(cancelled.payload.status_reason === 'Patient called to cancel', 'cancellation reason was not preserved');
  ok('cancellation reason is preserved');

  const noShowSlot = await firstFreeSlot(managerToken, doctorId);
  const noShowVisit = await request('/appointments', {
    method: 'POST',
    token: managerToken,
    body: {
      patientId: patientB.id,
      providerId: doctorId,
      startsAt: noShowSlot,
      durationMin: 30,
      visitType: 'Scenario 015 no-show',
      origin: 'scheduled',
    },
  });
  expect(noShowVisit.response.status === 201, `no-show appointment create failed: ${noShowVisit.response.status}`);
  const noReasonNoShow = await postStatus(receptionToken, noShowVisit.payload.id, 'no_show');
  expect(noReasonNoShow.response.status === 400, `no-show without reason was not rejected: ${noReasonNoShow.response.status}`);
  const noShow = await postStatus(receptionToken, noShowVisit.payload.id, 'no_show', 'Patient did not arrive');
  expect(noShow.response.ok, `no-show transition failed: ${noShow.response.status}`);
  expect(noShow.payload.status_reason === 'Patient did not arrive', 'no-show reason was not preserved');
  const noShowHistory = await request(`/appointments/${noShowVisit.payload.id}/status-history`, { token: managerToken });
  expect(noShowHistory.response.ok, `no-show history failed: ${noShowHistory.response.status}`);
  expect(noShowHistory.payload.some((row) => row.to_status === 'no_show' && row.reason === 'Patient did not arrive'), 'no-show reason missing from status history');
  ok('no-show reason is required, preserved, and traced in history');

  const foreign = await createForeignPractice(pool);
  const foreignToken = await signIn(foreign.email, foreign.practiceId);
  const foreignPatientAttack = await request('/encounters', {
    method: 'POST',
    token: foreignToken,
    body: { patientId: patientA.id, noteType: 'SOAP note' },
  });
  expect(foreignPatientAttack.response.status === 404, `foreign actor saw primary patient: ${foreignPatientAttack.response.status}`);
  const foreignAppointmentAttack = await request('/encounters', {
    method: 'POST',
    token: doctorToken,
    body: { patientId: patientA.id, appointmentId: foreign.appointmentId, noteType: 'SOAP note' },
  });
  expect(foreignAppointmentAttack.response.status === 404, `primary actor saw foreign appointment: ${foreignAppointmentAttack.response.status}`);
  ok('cross-tenant encounter links fail closed');

  const invalidLinks = await pool.query(
    `SELECT count(*)::int AS count
       FROM luminary.encounter e
       JOIN luminary.appointment a ON a.id = e.appointment_id
      WHERE e.created_at >= $1::timestamptz
        AND e.deleted_at IS NULL
        AND (e.practice_id <> a.practice_id OR e.patient_id <> a.patient_id)`,
    [startMarker],
  );
  expect(Number(invalidLinks.rows[0].count) === 0, 'invalid encounter/appointment links were persisted');
  ok('database integrity backstop left no invalid encounter links');

  await pool.end();
  console.log('Scenario 015 smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
