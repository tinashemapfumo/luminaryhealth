/**
 * Lightweight contract checks for the canonical claims architecture.
 *
 * This does not need a database or a real NH263 service. It verifies the parts
 * that must stay true before the external specification arrives: Luminary owns
 * the canonical model, adapters are swappable, NH263 remains a skeleton, and
 * claim mutations have timeline/transmission surfaces.
 */
import { readFile } from 'node:fs/promises';
import { adapterFor, NH263Adapter } from '../src/modules/claims/adapters.js';
import { CLAIM_STATUSES } from '../src/modules/claims/claims.types.js';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`  x ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ✓ ${label}`);
};

console.log('\nClaim lifecycle');
check('draft is a canonical state', CLAIM_STATUSES.includes('DRAFT'), true);
check('submission in progress is explicit', CLAIM_STATUSES.includes('SUBMITTING'), true);
check('partial approval is distinct', CLAIM_STATUSES.includes('PARTIALLY_APPROVED'), true);
check('requires action is distinct', CLAIM_STATUSES.includes('REQUIRES_ACTION'), true);
check('failed transmission is distinct', CLAIM_STATUSES.includes('FAILED'), true);

console.log('\nAdapters');
check('manual adapter is available', adapterFor('MANUAL').key, 'MANUAL');
check('email/PDF adapter is available', adapterFor('EMAIL_PDF').key, 'EMAIL_PDF');
check('NH263 adapter is available', adapterFor('NH263').key, 'NH263');
check('NH263 adapter refuses validation until docs arrive', new NH263Adapter().validateClaim({} as never).valid, false);

console.log('\nSchema surfaces');
const migration = await readFile(new URL('../db/migrations/021_canonical_claims.sql', import.meta.url), 'utf8');
[
  'claim_line',
  'claim_diagnosis',
  'claim_event',
  'claim_transmission',
  'claim_adjudication',
  'claim_attachment',
  'claim_remittance',
  'claim_eligibility_result',
  'claim_authorisation',
].forEach((table) => check(`${table} exists`, migration.includes(`luminary.${table}`), true));
check('raw payloads are references, not ordinary log blobs', migration.includes('raw_payload_ref'), true);
check('tenant helper is applied to claim lines', migration.includes("make_tenant_table('luminary.claim_line')"), true);

console.log('\nAPI surface');
const routes = await readFile(new URL('../src/modules/claims/claims.routes.ts', import.meta.url), 'utf8');
[
  "'/claims'",
  "'/claims/:id/validate'",
  "'/claims/:id/preparation-context'",
  "'/claims/:id/preparation'",
  "'/claims/:id/submit'",
  "'/claims/:id/refresh-status'",
  "'/claims/:id/events'",
  "'/claims/:id/transmissions'",
  "'/claims/:id/adjudication'",
  "'/claims/:id/attachments'",
  "'/integrations/nh263/webhook'",
].forEach((path) => check(`${path} route exists`, routes.includes(path), true));
check('submit route requires submitClaims', routes.includes("requirePermission('submitClaims')"), true);
check('transmissions require their own permission', routes.includes("requirePermission('viewClaimTransmissions')"), true);

if (failures > 0) {
  console.error(`\nx ${failures} claims rule(s) broken\n`);
  process.exit(1);
}
console.log('\n✓ canonical claims architecture checks hold\n');
