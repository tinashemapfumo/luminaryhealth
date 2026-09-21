import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePool, withTenant, withoutTenant } from '../src/platform/db.js';
import { mintCredential, signRequest } from '../src/platform/integration-keys.js';
import { executiveInsightRepository } from '../src/modules/executive-insight/executive-insight.repository.js';

const baseUrl = process.env.EXECUTIVE_INSIGHT_BASE_URL ?? 'http://127.0.0.1:4001';
const domains = ['executive-summary', 'revenue', 'claims', 'patients', 'appointments', 'operations'] as const;
const forbiddenKeys = /^(patientName|fullName|nationalId|phone|email|diagnosis|clinicalSummary)$/i;

type TestCredential = ReturnType<typeof mintCredential> & { id: string };

function containsPiiKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPiiKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => forbiddenKeys.test(key) || containsPiiKey(child));
}

async function signedPost(path: string, credential: TestCredential, body: string, options: {
  timestamp?: string; signature?: string;
} = {}) {
  const timestamp = options.timestamp ?? String(Date.now());
  const signature = options.signature ?? signRequest(credential.secretHash, timestamp, body);
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-luminary-key': credential.keyId,
      'x-luminary-timestamp': timestamp,
      'x-luminary-signature': signature,
    },
    body,
  });
}

async function createCredential(practiceId: string, scope: 'agent:report' | 'agent:insight'): Promise<TestCredential> {
  const credential = { ...mintCredential(), id: randomUUID() };
  await withTenant({ practiceId, userId: null }, (client) => client.query(
    `INSERT INTO luminary.integration_credential (id, practice_id, name, key_id, secret_hash, scopes)
     VALUES ($1, $2, $3, $4, $5, $6::text[])`,
    [credential.id, practiceId, `Executive Insight smoke ${scope}`, credential.keyId, credential.secretHash, [scope]],
  ));
  return credential;
}

async function main() {
  const { rows } = await withoutTenant((client) => client.query<{ id: string }>(
    `SELECT id FROM luminary.practice WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  ));
  const practiceId = rows[0]?.id;
  assert.ok(practiceId, 'A demo practice is required');

  const reportCredential = await createCredential(practiceId, 'agent:report');
  const legacyCredential = await createCredential(practiceId, 'agent:insight');
  const body = JSON.stringify({ period: 'last_30_days', compare: 'previous_period' });

  try {
    for (const domain of domains) {
      const response = await signedPost(`/agent/reports/${domain}`, reportCredential, body);
      const responseBody = await response.text();
      assert.equal(response.status, 200, `${domain}: ${response.status} ${responseBody}`);
      const payload = JSON.parse(responseBody) as { success: boolean; data: unknown; meta?: { source?: string } };
      assert.equal(payload.success, true, `${domain} success envelope`);
      assert.equal(payload.meta?.source, 'luminary', `${domain} source metadata`);
      assert.equal(containsPiiKey(payload.data), false, `${domain} must be aggregate-only`);
    }

    const compatibility = await signedPost('/agent/insight/executive-summary', legacyCredential, body);
    const compatibilityBody = await compatibility.text();
    assert.equal(compatibility.status, 200, `compatibility route: ${compatibility.status} ${compatibilityBody}`);

    const wrongScope = await signedPost('/agent/reports/executive-summary', legacyCredential, body);
    assert.equal(wrongScope.status, 403, 'canonical route must require agent:report');

    const badSignature = await signedPost('/agent/reports/executive-summary', reportCredential, body, { signature: '0'.repeat(64) });
    assert.equal(badSignature.status, 401, 'invalid signatures must fail closed');

    const staleTimestamp = String(Date.now() - 6 * 60 * 1000);
    const stale = await signedPost('/agent/reports/executive-summary', reportCredential, body, { timestamp: staleTimestamp });
    assert.equal(stale.status, 401, 'stale signed requests must be rejected');

    const tenantOverrideBody = JSON.stringify({ period: 'today', compare: 'none', practiceId: randomUUID() });
    const tenantOverride = await signedPost('/agent/reports/executive-summary', reportCredential, tenantOverrideBody);
    assert.equal(tenantOverride.status, 400, 'tenant selectors must be rejected by the strict body schema');

    const allTime = { from: '2000-01-01', to: '2099-12-31', toExclusive: '2100-01-01' };
    const knownTenantAppointments = await withTenant({ practiceId, userId: null }, (client) =>
      executiveInsightRepository.appointments(client, allTime, 'Africa/Harare'),
    );
    const unrelatedTenantAppointments = await withTenant({ practiceId: randomUUID(), userId: null }, (client) =>
      executiveInsightRepository.appointments(client, allTime, 'Africa/Harare'),
    );
    assert.ok(knownTenantAppointments.scheduled > 0, 'demo tenant should contain appointment fixtures');
    assert.equal(unrelatedTenantAppointments.scheduled, 0, 'report queries must isolate an unrelated tenant context');

    console.log(`Executive Insight smoke passed: ${domains.length} canonical reports, auth, scope, schema, PII, and tenant-query checks.`);
  } finally {
    await withTenant({ practiceId, userId: null }, (client) => client.query(
      `UPDATE luminary.integration_credential
          SET active = false, deleted_at = now()
        WHERE id = ANY($1::uuid[])`,
      [[reportCredential.id, legacyCredential.id]],
    ));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
