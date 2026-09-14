import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { dispatchOnce, dispatcherStatus } from '../src/modules/messaging/messaging.dispatcher.js';
import { signRequest } from '../src/platform/integration-keys.js';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const DB = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';
const PRACTICE = process.env.PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || 'manager.test@h.co.zw';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin.test@h.co.zw';
const PASSWORD = process.env.PASSWORD || process.env.LUMINARY_TEST_PASSWORD || 'luminary';

const ok = (name, detail = '') => console.log(`ok - ${name}${detail ? `: ${detail}` : ''}`);
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  const payload = body && typeof body !== 'string' ? JSON.stringify(body) : body;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: payload,
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { response, payload: parsed };
}

async function signIn(email = MANAGER_EMAIL) {
  const { response, payload } = await request('/auth/session', {
    method: 'POST',
    body: { practiceId: PRACTICE, email, password: PASSWORD },
  });
  expect(response.status === 201, `sign-in failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload.token;
}

function patientBody(label, consentComms = true, phone = null) {
  const stamp = randomUUID().slice(0, 8);
  return {
    reference: `S017-${label}-${stamp}`,
    fullName: `Scenario Seventeen ${label}`,
    dateOfBirth: '1990-07-08',
    sex: 'Female',
    nationalId: null,
    phone: phone ?? `077${Math.floor(1000000 + Math.random() * 8999999)}`,
    addressCity: 'Harare',
    emergencyName: 'Scenario Contact',
    emergencyRelation: 'Sibling',
    emergencyPhone: `071${Math.floor(1000000 + Math.random() * 8999999)}`,
    consentTreatment: true,
    consentComms,
  };
}

async function createPatient(token, label, consentComms = true, phone = null) {
  const created = await request('/patients', {
    method: 'POST',
    token,
    body: patientBody(label, consentComms, phone),
  });
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
      visitType: 'Scenario 017 visit',
      reason: 'Scenario 017 visit',
      mode: 'in_person',
    },
  });
  expect(created.response.status === 201, `appointment create failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  return created.payload;
}

async function withTenant(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('luminary.practice_id', $1, true),
              set_config('luminary.user_id', $2, true),
              set_config('luminary.node', $3, true)`,
      [PRACTICE, '', 'scenario017-smoke'],
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

function startProvider() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(text);
      calls.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ providerRef: `s017-provider-${body.messageId}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function signedIntegrationRequest(path, credential, body, signature = null) {
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const sig = signature ?? signRequest(credential.signingKey, timestamp, text);
  return request(path, {
    method: 'POST',
    body: text,
    headers: {
      'x-luminary-key': credential.key_id,
      'x-luminary-timestamp': timestamp,
      'x-luminary-signature': sig,
    },
  });
}

async function main() {
  const token = await signIn();
  const adminToken = await signIn(ADMIN_EMAIL);
  ok('authenticated manager');

  const pool = new pg.Pool({ connectionString: DB });
  const provider = await startProvider();
  const originalSettings = await withTenant(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT messaging_webhook_url, messaging_webhook_secret
         FROM luminary.practice_settings
        WHERE practice_id = luminary.current_practice_id()`,
    );
    await client.query(
      `UPDATE luminary.practice_settings
          SET messaging_webhook_url = $1,
              messaging_webhook_secret = 'scenario017-secret'
        WHERE practice_id = luminary.current_practice_id()`,
      [provider.url],
    );
    return rows[0] ?? {};
  });

  try {
    const patientA = await createPatient(token, 'Alpha', true);
    const patientB = await createPatient(token, 'Bravo', true);
    const apptA = await createWalkIn(token, patientA.id);
    const apptB = await createWalkIn(token, patientB.id);

    const queued = await request('/messages', {
      method: 'POST',
      token,
      body: {
        patientId: patientA.id,
        appointmentId: apptA.id,
        channel: 'sms',
        template: 'appointment_confirmation',
        body: 'Scenario 017 appointment confirmation',
      },
    });
    expect(queued.response.status === 201, `message queue failed: ${queued.response.status} ${JSON.stringify(queued.payload)}`);
    expect(queued.payload.appointment_id === apptA.id, 'message did not retain appointment_id');
    ok('outbound message queued with appointment linkage');

    const mismatch = await request('/messages', {
      method: 'POST',
      token,
      body: {
        patientId: patientA.id,
        appointmentId: apptB.id,
        channel: 'sms',
        template: 'appointment_confirmation',
        body: 'Wrong appointment should fail',
      },
    });
    expect(!mismatch.response.ok, `wrong patient/appointment combination was accepted: ${JSON.stringify(mismatch.payload)}`);
    ok('wrong patient/appointment message rejected');

    const result = await dispatchOnce();
    expect(result.attempted >= 1, `dispatcher did not attempt queued message: ${JSON.stringify(result)}`);
    expect(provider.calls.some((call) => call.body.messageId === queued.payload.id), 'provider did not receive queued message');
    const sent = await withTenant(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT status, attempts, provider_ref FROM luminary.message WHERE id = $1`,
        [queued.payload.id],
      );
      return rows[0];
    });
    expect(sent.status === 'sent', `message was not marked sent: ${JSON.stringify(sent)}`);
    expect(sent.attempts > 0, 'dispatch attempt count did not increment');
    expect(sent.provider_ref === `s017-provider-${queued.payload.id}`, 'provider reference was not persisted');
    ok('dispatcher sends queued message and persists provider reference');

    const consentPatient = await createPatient(token, 'Consent', true);
    const consentMessage = await request('/messages', {
      method: 'POST',
      token,
      body: {
        patientId: consentPatient.id,
        channel: 'sms',
        template: 'appointment_reminder',
        body: 'Scenario 017 consent-sensitive reminder',
      },
    });
    expect(consentMessage.response.status === 201, 'consent-sensitive message did not queue');
    const consentPatch = await request(`/patients/${consentPatient.id}`, {
      method: 'PATCH',
      token,
      body: { consentComms: false },
    });
    expect(consentPatch.response.ok, `consent update failed: ${consentPatch.response.status} ${JSON.stringify(consentPatch.payload)}`);
    await dispatchOnce();
    const cancelled = await withTenant(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT status, last_error FROM luminary.message WHERE id = $1`,
        [consentMessage.payload.id],
      );
      return rows[0];
    });
    expect(cancelled.status === 'cancelled', `withdrawn-consent message was not cancelled: ${JSON.stringify(cancelled)}`);
    ok('dispatcher re-checks consent before send');

    const staleMessage = await request('/messages', {
      method: 'POST',
      token,
      body: {
        patientId: patientB.id,
        appointmentId: apptB.id,
        channel: 'sms',
        template: 'appointment_reminder',
        body: 'Scenario 017 stale reminder',
      },
    });
    expect(staleMessage.response.status === 201, 'stale reminder did not queue');
    const cancelledStatus = await request(`/appointments/${apptB.id}/status`, {
      method: 'POST',
      token,
      body: { status: 'cancelled', reason: 'Scenario 017 cancellation' },
    });
    expect(cancelledStatus.response.ok, `appointment cancellation failed: ${cancelledStatus.response.status} ${JSON.stringify(cancelledStatus.payload)}`);
    const stale = await withTenant(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT status, last_error FROM luminary.message WHERE id = $1`,
        [staleMessage.payload.id],
      );
      return rows[0];
    });
    expect(stale.status === 'cancelled', `appointment cancellation did not cancel reminder: ${JSON.stringify(stale)}`);
    ok('appointment cancellation cancels queued reminders');

    const credential = await request('/integrations/credentials', {
      method: 'POST',
      token: adminToken,
      body: { name: `Scenario 017 ${randomUUID()}`, scopes: ['messaging:inbound', 'messaging:status'] },
    });
    expect(credential.response.status === 201, `credential create failed: ${credential.response.status} ${JSON.stringify(credential.payload)}`);
    const stored = await pool.query(
      `SELECT secret_hash,
              EXISTS (
                SELECT 1
                  FROM information_schema.columns
                 WHERE table_schema = 'luminary'
                   AND table_name = 'integration_credential'
                   AND column_name = 'secret'
              ) AS has_raw_secret_column
         FROM luminary.integration_credential WHERE id = $1`,
      [credential.payload.id],
    );
    expect(stored.rows[0]?.secret_hash && !stored.rows[0].has_raw_secret_column, 'credential storage/signing material check failed');

    const inbound = await signedIntegrationRequest('/integrations/messages/inbound', credential.payload, {
      channel: 'sms',
      from: patientA.phone,
      body: 'Scenario 017 inbound hello',
      providerRef: `s017-in-${randomUUID()}`,
    });
    expect(inbound.response.status === 201, `valid signed inbound failed: ${inbound.response.status} ${JSON.stringify(inbound.payload)}`);
    expect(inbound.payload.matchedPatient?.id === patientA.id, 'signed inbound did not match the correct patient');
    ok('valid integration credential authenticates through RLS bootstrap');

    const badSignature = await signedIntegrationRequest('/integrations/messages/inbound', credential.payload, {
      channel: 'sms',
      from: patientA.phone,
      body: 'bad signature',
      providerRef: `s017-bad-${randomUUID()}`,
    }, '00bad');
    expect(badSignature.response.status === 401, `bad signature did not fail closed: ${badSignature.response.status}`);
    ok('invalid integration signature rejects');

    const receipt = await signedIntegrationRequest('/integrations/messages/status', credential.payload, {
      messageId: queued.payload.id,
      providerRef: sent.provider_ref,
      status: 'delivered',
      detail: 'carrier delivered',
    });
    expect(receipt.response.ok, `delivery receipt failed: ${receipt.response.status} ${JSON.stringify(receipt.payload)}`);
    const late = await signedIntegrationRequest('/integrations/messages/status', credential.payload, {
      messageId: queued.payload.id,
      providerRef: sent.provider_ref,
      status: 'sent',
      detail: 'late sent',
    });
    expect(late.response.ok && late.payload.applied === false, `late receipt regressed or failed: ${JSON.stringify(late.payload)}`);
    ok('delivery receipts apply without status regression');

    const status = await request('/messages/status', { token });
    expect(status.response.ok, `message status endpoint failed: ${status.response.status}`);
    expect(typeof status.payload.providerConfigured === 'boolean', 'message status did not include provider configuration');
    expect(status.payload.dispatcher && Object.hasOwn(status.payload.dispatcher, 'running'), 'message status did not include dispatcher state');
    expect(Object.hasOwn(dispatcherStatus(), 'configured'), 'dispatcherStatus export is missing configured state');
    ok('messaging operational status is exposed');
  } finally {
    await withTenant(pool, (client) =>
      client.query(
        `UPDATE luminary.practice_settings
            SET messaging_webhook_url = $1,
                messaging_webhook_secret = $2
          WHERE practice_id = luminary.current_practice_id()`,
        [originalSettings.messaging_webhook_url ?? null, originalSettings.messaging_webhook_secret ?? null],
      ));
    await provider.close();
    await pool.end();
  }

  console.log('Scenario 017 smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
