import pg from 'pg';

const base = process.env.API_BASE_URL || 'http://localhost:4000';
const practice = process.env.LUMINARY_TEST_PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const email = process.env.LUMINARY_TEST_MANAGER_EMAIL || 'manager.test@h.co.zw';
const password = process.env.LUMINARY_TEST_PASSWORD || 'luminary';
const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

async function request(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

const post = (path, token, body) => request('POST', path, token, body);
const get = (path, token) => request('GET', path, token);

const login = await post('/auth/session', null, { practiceId: practice, email, password });
const token = login.token;

const payer = await post('/payers', token, { name: `Scenario007 Aid ${stamp}`, active: true });
const scheme = await post('/settings/schemes', token, {
  payerId: payer.id,
  name: `Scenario007 Plan ${stamp}`,
  reimbursePercent: 80,
  requiresPreauth: false,
  active: true,
});

async function makeClaim(suffix) {
  const patient = await post('/patients', token, {
    reference: `S7-${stamp}-${suffix}`,
    fullName: `Scenario Seven Patient ${suffix}`,
    dateOfBirth: '1990-01-15',
    sex: 'Female',
    nationalId: `S7-${stamp}-${suffix}`,
    phone: `077${suffix.charCodeAt(0)}555${stamp.slice(-4)}`,
    addressCity: 'Harare',
    emergencyName: 'Scenario Contact',
    emergencyRelation: 'Sibling',
    emergencyPhone: `078${suffix.charCodeAt(0)}555${stamp.slice(-4)}`,
    schemeId: scheme.id,
    memberNumber: `SCN007-${stamp}-${suffix}`,
    principalMember: `Scenario Principal ${suffix}`,
    dependantCode: '00',
    coverEffectiveFrom: '2026-01-01',
    coverValidUntil: '2026-12-31',
    coverStatus: 'Active',
    consentTreatment: true,
    consentComms: true,
  });
  const invoice = await post('/invoices', token, {
    patientId: patient.id,
    currency: 'USD',
    dueInDays: 30,
    idempotencyKey: `scenario007-inv-${stamp}-${suffix}`,
    lines: [{ origin: 'manual', code: 'FBC', description: 'Full blood count', quantity: 1, unitPrice: 15 }],
  });
  const claim = await post('/claims', token, { invoiceId: invoice.id, submissionChannel: 'NH263' });
  return { patient, invoice, claim };
}

const first = await makeClaim('A');
const second = await makeClaim('B');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
for (const claim of [first.claim, second.claim]) {
  await client.query(
    `INSERT INTO luminary.claim_diagnosis
       (practice_id, claim_id, code, description, kind, sequence, source)
     VALUES ($1, $2, 'D64.9', 'Anaemia, unspecified', 'primary', 1, 'scenario007')`,
    [practice, claim.id],
  );
}
await client.end();

const nhValidate = await post(`/claims/${first.claim.id}/validate`, token, { submissionChannel: 'NH263' });
const manualSubmit = await post(`/claims/${first.claim.id}/submit`, token, {
  submissionChannel: 'MANUAL',
  idempotencyKey: `scenario007-manual-${stamp}`,
});
const afterManual = await get(`/claims/${first.claim.id}`, token);
await post(`/claims/${first.claim.id}/refresh-status`, token, {});
const afterRefresh = await get(`/claims/${first.claim.id}`, token);

const failedRefresh = await post(`/claims/${second.claim.id}/refresh-status`, token, {});
const retry = await post(`/claims/${second.claim.id}/submit`, token, {
  submissionChannel: 'MANUAL',
  idempotencyKey: `scenario007-retry-${stamp}`,
});
const afterRetry = await get(`/claims/${second.claim.id}`, token);

const tx1 = await get(`/claims/${first.claim.id}/transmissions`, token);
const tx2 = await get(`/claims/${second.claim.id}/transmissions`, token);

const result = {
  nh263ValidationValid: nhValidate.valid,
  nh263ValidationErrors: nhValidate.errors.map((entry) => entry.code).join(','),
  defaultChannel: first.claim.submission_channel,
  manualSubmitStatus: manualSubmit.claim.status,
  afterManualChannel: afterManual.submission_channel,
  afterManualExternal: afterManual.external_reference,
  refreshStatus: afterRefresh.status,
  refreshChannel: afterRefresh.submission_channel,
  firstTransmissions: tx1.map((t) => `${t.direction}:${t.adapter}:${t.status}`).join('|'),
  failedPathStatus: failedRefresh.claim.status,
  retrySubmitted: retry.submitted,
  retryStatus: afterRetry.status,
  retryChannel: afterRetry.submission_channel,
  secondTransmissions: tx2.map((t) => `${t.direction}:${t.adapter}:${t.status}`).join('|'),
};

const checks = [
  ['NH263 remains blocked', result.nh263ValidationValid === false && result.nh263ValidationErrors.includes('ADAPTER_PENDING_SPEC')],
  ['manual override persisted', result.afterManualChannel === 'MANUAL'],
  ['manual refresh stayed manual', result.refreshChannel === 'MANUAL'],
  ['manual refresh did not fail claim', result.refreshStatus === 'ACKNOWLEDGED'],
  ['failed claim retried successfully', result.failedPathStatus === 'FAILED' && result.retrySubmitted === true],
  ['retry persisted manual channel', result.retryStatus === 'ACKNOWLEDGED' && result.retryChannel === 'MANUAL'],
  ['history remained append-only', result.firstTransmissions.includes('outbound:MANUAL:succeeded')
    && result.firstTransmissions.includes('inbound:MANUAL:received')
    && result.secondTransmissions.includes('inbound:NH263:failed')
    && result.secondTransmissions.includes('outbound:MANUAL:succeeded')],
];

for (const [label, ok] of checks) {
  if (!ok) {
    console.error(JSON.stringify(result, null, 2));
    throw new Error(`Scenario 007 smoke failed: ${label}`);
  }
}

console.log(JSON.stringify(result, null, 2));
