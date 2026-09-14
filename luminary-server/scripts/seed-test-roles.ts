/**
 * Development-only role fixtures.
 *
 * The verification seed deliberately stays small, but live UI checks need one
 * account for each supported role. This script is idempotent so it can be run
 * after a fresh seed or against an already-running local database.
 */
import { Client } from 'pg';
import argon2 from 'argon2';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.LUMINARY_ALLOW_PRODUCTION_TEST_SEED !== 'true') {
  console.error('Refusing to seed test-role accounts while NODE_ENV=production. Set LUMINARY_ALLOW_PRODUCTION_TEST_SEED=true only for a disposable target.');
  process.exit(1);
}

const practiceId = process.env.LUMINARY_TEST_PRACTICE_ID || '11111111-1111-1111-1111-111111111111';
const password = process.env.LUMINARY_TEST_PASSWORD || 'luminary';

const accounts = [
  ['10000000-0000-0000-0000-000000000001', 'admin.test@h.co.zw', 'Test Administrator', 'Test Admin', 'admin', false],
  ['10000000-0000-0000-0000-000000000002', 'manager.test@h.co.zw', 'Test Practice Manager', 'Test Manager', 'manager', false],
  ['10000000-0000-0000-0000-000000000003', 'doctor.test@h.co.zw', 'Test Doctor', 'Test Doctor', 'doctor', true],
  ['10000000-0000-0000-0000-000000000004', 'nurse.test@h.co.zw', 'Test Nurse', 'Test Nurse', 'nurse', false],
  ['10000000-0000-0000-0000-000000000005', 'reception.test@h.co.zw', 'Test Receptionist', 'Test Reception', 'receptionist', false],
] as const;

const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
});

const client = new Client({ connectionString: url });
await client.connect();

for (const [id, email, fullName, displayName, role, isProvider] of accounts) {
  await client.query(
    `INSERT INTO luminary.app_user
       (id, practice_id, email, full_name, display_name, role, is_provider, password_hash, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
     ON CONFLICT (id) DO UPDATE SET
       practice_id = EXCLUDED.practice_id,
       email = EXCLUDED.email,
       full_name = EXCLUDED.full_name,
       display_name = EXCLUDED.display_name,
       role = EXCLUDED.role,
       is_provider = EXCLUDED.is_provider,
       password_hash = EXCLUDED.password_hash,
       active = true,
       deleted_at = NULL`,
    [id, practiceId, email, fullName, displayName, role, isProvider, hash],
  );
}

console.log(`seeded ${accounts.length} test-role accounts in ${practiceId} (password: "${password}")`);
await client.end();
