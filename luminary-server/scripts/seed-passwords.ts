/**
 * Sets a known password on the seeded users so the API can be exercised.
 * Development only — real accounts are created by invitation and the holder
 * chooses the secret, which is why there is no admin-sets-password path.
 */
import { Client } from 'pg';
import argon2 from 'argon2';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
if (process.env.NODE_ENV === 'production' && process.env.LUMINARY_ALLOW_PRODUCTION_TEST_SEED !== 'true') {
  console.error('Refusing to seed passwords while NODE_ENV=production. Set LUMINARY_ALLOW_PRODUCTION_TEST_SEED=true only for a disposable demo target.');
  process.exit(1);
}

const password = process.env.LUMINARY_TEST_PASSWORD || 'luminary';

const client = new Client({ connectionString: url });
await client.connect();
const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
const { rowCount } = await client.query('UPDATE luminary.app_user SET password_hash = $1', [hash]);
console.log(`set password on ${rowCount} users (password: "${password}")`);
await client.end();
