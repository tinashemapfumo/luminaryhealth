import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const DB = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';
const PRACTICE = process.env.PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const DOCTOR_EMAIL = process.env.DOCTOR_EMAIL || 'doctor.test@h.co.zw';
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || 'manager.test@h.co.zw';
const PASSWORD = process.env.PASSWORD || 'luminary';

const ok = (name, detail = '') => console.log(`ok - ${name}${detail ? `: ${detail}` : ''}`);

async function request(path, { method = 'GET', token, body, rawBody } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body || rawBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
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

async function main() {
  const doctorToken = await signIn(DOCTOR_EMAIL);
  const managerToken = await signIn(MANAGER_EMAIL);
  ok('authenticated live doctor and manager test accounts');

  const patients = await request('/patients', { token: doctorToken });
  if (!patients.response.ok || patients.payload.length === 0) {
    throw new Error(`patient lookup failed: ${patients.response.status}`);
  }
  const patient = patients.payload[0];
  const otherPatient = patients.payload.find((item) => item.id !== patient.id);
  ok('selected disposable patient', patient.id);

  const oversizedBody = JSON.stringify({
    filename: 'too-large.pdf',
    contentType: 'application/pdf',
    byteSize: 26 * 1024 * 1024,
    dataBase64: randomBytes(31 * 1024 * 1024).toString('base64'),
  });
  const oversized = await request(`/patients/${patient.id}/documents`, {
    method: 'POST',
    token: doctorToken,
    rawBody: oversizedBody,
  });
  if (oversized.response.status !== 413 || oversized.payload?.error !== 'payload_too_large') {
    throw new Error(`oversized upload returned ${oversized.response.status}: ${JSON.stringify(oversized.payload)}`);
  }
  ok('oversized upload maps to controlled 413');

  const bytes = Buffer.from('%PDF-1.4\n% Luminary Scenario 013 smoke\n%%EOF\n');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const upload = await request(`/patients/${patient.id}/documents`, {
    method: 'POST',
    token: doctorToken,
    body: {
      filename: 'scenario-013.pdf',
      contentType: 'application/pdf',
      byteSize: bytes.length,
      dataBase64: bytes.toString('base64'),
      kind: 'Scenario 013 smoke',
      notes: 'Disposable storage hardening verification',
    },
  });
  if (upload.response.status !== 201) {
    throw new Error(`normal upload failed: ${upload.response.status} ${JSON.stringify(upload.payload)}`);
  }
  if (upload.payload.checksum !== checksum) throw new Error('uploaded checksum did not match expected SHA-256');
  ok('normal PDF upload persisted metadata and checksum', upload.payload.id);

  const secondBytes = Buffer.from('%PDF-1.4\n% Same filename, different bytes\n%%EOF\n');
  const secondUpload = await request(`/patients/${patient.id}/documents`, {
    method: 'POST',
    token: doctorToken,
    body: {
      filename: 'scenario-013.pdf',
      contentType: 'application/pdf',
      byteSize: secondBytes.length,
      dataBase64: secondBytes.toString('base64'),
      kind: 'Scenario 013 same filename',
    },
  });
  if (secondUpload.response.status !== 201) {
    throw new Error(`same filename upload failed: ${secondUpload.response.status}`);
  }
  if (secondUpload.payload.id === upload.payload.id) {
    throw new Error('same filename upload reused an existing document id');
  }
  ok('same filename creates a distinct document record', secondUpload.payload.id);

  const download = await request(`/documents/${upload.payload.id}/download`, { token: doctorToken });
  if (!download.response.ok) throw new Error(`download failed: ${download.response.status}`);
  const downloadedChecksum = createHash('sha256').update(download.payload).digest('hex');
  if (downloadedChecksum !== checksum) throw new Error('downloaded bytes checksum did not match upload');
  ok('authenticated download returns matching bytes');

  const pool = new pg.Pool({ connectionString: DB });
  const before = await pool.query(
    `SELECT id, storage_key, deleted_at FROM luminary.patient_document WHERE id = ANY($1::uuid[])`,
    [[upload.payload.id, secondUpload.payload.id]],
  );
  if (before.rows.length !== 2 || before.rows.some((row) => !row.storage_key || row.deleted_at)) {
    throw new Error('uploaded document row not active before archive');
  }
  const storageKeys = new Set(before.rows.map((row) => row.storage_key));
  if (storageKeys.size !== 2) throw new Error('same filename uploads shared a storage key');
  ok('document row is active before archive');

  if (otherPatient) {
    const foreignEncounter = await request('/encounters', {
      method: 'POST',
      token: doctorToken,
      body: { patientId: otherPatient.id, noteType: 'Scenario 013 wrong-patient proof' },
    });
    if (foreignEncounter.response.status !== 201) {
      throw new Error(`foreign encounter setup failed: ${foreignEncounter.response.status}`);
    }
    const wrongPatient = await request(`/patients/${patient.id}/documents`, {
      method: 'POST',
      token: doctorToken,
      body: {
        encounterId: foreignEncounter.payload.id,
        filename: 'wrong-patient.pdf',
        contentType: 'application/pdf',
        byteSize: bytes.length,
        dataBase64: bytes.toString('base64'),
      },
    });
    if (wrongPatient.response.status !== 400) {
      throw new Error(`wrong patient/encounter upload returned ${wrongPatient.response.status}`);
    }
    ok('wrong patient plus encounter mismatch is rejected before storage');
  }

  const signedDraft = await request('/encounters', {
    method: 'POST',
    token: doctorToken,
    body: { patientId: patient.id, noteType: 'Scenario 013 signed attachment proof' },
  });
  if (signedDraft.response.status !== 201) {
    throw new Error(`signed encounter setup failed: ${signedDraft.response.status}`);
  }
  const signedBody = {
    note_type: 'Scenario 013 signed attachment proof',
    subjective: 'Patient reports stable symptoms.',
    objective: 'Vitals reviewed.',
    assessment: 'Stable for document attachment verification.',
    plan: 'Attach document after signature without mutating note content.',
    follow_up: 'Routine',
    diagnoses: [{ code: 'Z02.9', label: 'Administrative examination, unspecified' }],
  };
  const savedSignedDraft = await request(`/encounters/${signedDraft.payload.id}`, {
    method: 'PUT',
    token: doctorToken,
    body: signedBody,
  });
  if (!savedSignedDraft.response.ok) {
    throw new Error(`signed encounter save failed: ${savedSignedDraft.response.status}`);
  }
  const signed = await request(`/encounters/${signedDraft.payload.id}/signature`, {
    method: 'POST',
    token: doctorToken,
    body: {},
  });
  if (![200, 201].includes(signed.response.status)) {
    throw new Error(`encounter signature failed: ${signed.response.status}`);
  }
  const signedBefore = await request(`/encounters/${signedDraft.payload.id}`, { token: doctorToken });
  const signedAttachment = await request(`/patients/${patient.id}/documents`, {
    method: 'POST',
    token: doctorToken,
    body: {
      encounterId: signedDraft.payload.id,
      filename: 'signed-encounter-attachment.pdf',
      contentType: 'application/pdf',
      byteSize: bytes.length,
      dataBase64: bytes.toString('base64'),
      kind: 'Signed encounter attachment',
    },
  });
  if (signedAttachment.response.status !== 201) {
    throw new Error(`signed encounter attachment failed: ${signedAttachment.response.status}`);
  }
  const signedAfter = await request(`/encounters/${signedDraft.payload.id}`, { token: doctorToken });
  for (const key of ['subjective', 'objective', 'assessment', 'plan', 'signed_at']) {
    if (signedBefore.payload[key] !== signedAfter.payload[key]) {
      throw new Error(`signed encounter field changed after document upload: ${key}`);
    }
  }
  ok('attachment to signed encounter leaves signed note content unchanged');

  const denied = await request(`/documents/${upload.payload.id}/archive`, {
    method: 'POST',
    token: managerToken,
    body: { reason: 'Unauthorized archive check' },
  });
  if (denied.response.status !== 403) {
    throw new Error(`unauthorized archive returned ${denied.response.status}`);
  }
  ok('unauthorized archive fails closed');

  const archived = await request(`/documents/${upload.payload.id}/archive`, {
    method: 'POST',
    token: doctorToken,
    body: { reason: 'Scenario 013 smoke archive' },
  });
  if (!archived.response.ok || !archived.payload.deleted_at) {
    throw new Error(`archive failed: ${archived.response.status} ${JSON.stringify(archived.payload)}`);
  }
  ok('authorized archive soft-deletes metadata');

  const activeList = await request(`/patients/${patient.id}/documents`, { token: doctorToken });
  if (!activeList.response.ok) throw new Error(`active document list failed: ${activeList.response.status}`);
  if (activeList.payload.some((doc) => doc.id === upload.payload.id)) {
    throw new Error('archived document still appears in active document list');
  }
  ok('active document list excludes archived document');

  const archivedDownload = await request(`/documents/${upload.payload.id}/download`, { token: doctorToken });
  if (archivedDownload.response.status !== 404) {
    throw new Error(`archived download returned ${archivedDownload.response.status}`);
  }
  ok('normal download excludes archived document');

  const after = await pool.query(
    `SELECT d.deleted_at, d.storage_key,
            EXISTS (
              SELECT 1 FROM luminary.audit_event a
               WHERE a.subject_type = 'patient'
                 AND a.action = 'Archived clinical document'
                 AND a.subject_id = d.patient_id
                 AND a.detail = 'Scenario 013 smoke archive'
            ) AS audited
       FROM luminary.patient_document d
      WHERE d.id = $1`,
    [upload.payload.id],
  );
  await pool.end();
  if (!after.rows[0]?.deleted_at) throw new Error('document deleted_at was not persisted');
  if (!after.rows[0]?.audited) throw new Error('archive audit event was not found');
  ok('archive audit event exists and preserves reason');

  const noAuth = await request(`/documents/${upload.payload.id}/download`);
  if (noAuth.response.status !== 401) {
    throw new Error(`unauthenticated download returned ${noAuth.response.status}`);
  }
  ok('unauthenticated document download fails closed');

  const storageRoot = await mkdtemp(join(tmpdir(), 'luminary-s013-'));
  process.env.CLIENT_FILE_STORAGE_PATH = storageRoot;
  process.env.DATABASE_URL = DB;
  const { clinicalService } = await import('../src/modules/clinical/clinical.service.ts');
  const fakeClient = {
    async query(sql) {
      if (String(sql).includes('SELECT id, full_name FROM luminary.patient')) {
        return { rows: [{ id: patient.id, full_name: patient.full_name || patient.name || 'Scenario Patient' }] };
      }
      if (String(sql).includes('INSERT INTO luminary.patient_document')) {
        throw new Error('simulated patient_document insert failure');
      }
      return { rows: [] };
    },
  };
  let failed = false;
  try {
    await clinicalService.uploadDocument(fakeClient, {
      userId: '11111111-1111-1111-1111-111111111111',
      practiceId: PRACTICE,
      role: 'doctor',
      registrationLapsed: false,
    }, {
      patientId: patient.id,
      filename: 'cleanup-proof.pdf',
      contentType: 'application/pdf',
      byteSize: bytes.length,
      dataBase64: bytes.toString('base64'),
    });
  } catch (error) {
    failed = /simulated patient_document insert failure/.test(error.message);
  }
  if (!failed) throw new Error('simulated insert failure was not preserved');
  const remaining = await readdir(storageRoot, { recursive: true });
  const remainingFiles = [];
  for (const entry of remaining) {
    const absolute = join(storageRoot, entry);
    if ((await stat(absolute)).isFile()) remainingFiles.push(entry);
  }
  await rm(storageRoot, { recursive: true, force: true });
  if (remainingFiles.length !== 0) {
    throw new Error(`compensating cleanup left files behind: ${remainingFiles.join(', ')}`);
  }
  ok('DB failure after file write cleans up the new storage object');

  console.log('Scenario 013 smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
