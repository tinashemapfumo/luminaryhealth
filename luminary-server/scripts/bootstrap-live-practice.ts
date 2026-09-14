import argon2 from 'argon2';
import pg from 'pg';

const { Pool } = pg;

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
};

const optional = (name: string, fallback: string): string =>
  process.env[name]?.trim() || fallback;

const databaseUrl =
  process.env.BOOTSTRAP_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('BOOTSTRAP_DATABASE_URL, MIGRATION_DATABASE_URL, or DATABASE_URL is required');
  process.exit(1);
}

const practiceName = required('BOOTSTRAP_PRACTICE_NAME');
const shortName = optional('BOOTSTRAP_PRACTICE_SHORT_NAME', practiceName);
const city = optional('BOOTSTRAP_PRACTICE_CITY', 'Harare');
const currency = optional('BOOTSTRAP_PRIMARY_CURRENCY', 'USD').toUpperCase();
const timezone = optional('BOOTSTRAP_TIMEZONE', 'Africa/Harare');
const email = required('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
const fullName = required('BOOTSTRAP_ADMIN_FULL_NAME');
const displayName = optional('BOOTSTRAP_ADMIN_DISPLAY_NAME', fullName);
const password = required('BOOTSTRAP_ADMIN_PASSWORD');
const nodeId = optional('NODE_ID', 'cloud');

if (password.length < 12) {
  console.error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('luminary.node', $1, true)`, [nodeId]);

  const { rows: zones } = await client.query(
    `SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1`,
    [timezone],
  );
  if (!zones[0]) throw new Error(`Invalid timezone: ${timezone}`);

  const existingPractice = await client.query<{ id: string }>(
    `SELECT id
       FROM luminary.practice
      WHERE lower(name) = lower($1)
        AND deleted_at IS NULL
      ORDER BY created_at
      LIMIT 1`,
    [practiceName],
  );

  const practiceId = existingPractice.rows[0]?.id ?? (
    await client.query<{ id: string }>(
      `INSERT INTO luminary.practice
         (name, short_name, city, primary_currency, plan, origin_node)
       VALUES ($1, $2, $3, $4, 'starter', $5)
       RETURNING id`,
      [practiceName, shortName, city, currency, nodeId],
    )
  ).rows[0].id;

  if (existingPractice.rows[0]) {
    await client.query(
      `UPDATE luminary.practice
          SET short_name = $2,
              city = $3,
              primary_currency = $4,
              updated_at = now()
        WHERE id = $1`,
      [practiceId, shortName, city, currency],
    );
  }

  await client.query(`SELECT set_config('luminary.practice_id', $1, true)`, [practiceId]);

  await client.query(
    `INSERT INTO luminary.practice_settings (practice_id, timezone)
     VALUES ($1, $2)
     ON CONFLICT (practice_id) DO UPDATE
       SET timezone = EXCLUDED.timezone,
           updated_at = now()`,
    [practiceId, timezone],
  );

  await client.query(
    `INSERT INTO luminary.room (practice_id, name, kind, active)
     VALUES ($1, 'Room 1', 'Consulting', true)
     ON CONFLICT DO NOTHING`,
    [practiceId],
  );

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const { rows: users } = await client.query<{ id: string }>(
    `INSERT INTO luminary.app_user
       (practice_id, email, full_name, display_name, initials, job_title, role, password_hash, active, is_provider)
     VALUES ($1, $2, $3, $4, $5, 'Practice administrator', 'admin', $6, true, false)
     ON CONFLICT (practice_id, email) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           display_name = EXCLUDED.display_name,
           initials = EXCLUDED.initials,
           job_title = EXCLUDED.job_title,
           role = EXCLUDED.role,
           password_hash = EXCLUDED.password_hash,
           active = true,
           is_provider = false,
           deleted_at = NULL,
           updated_at = now()
     RETURNING id`,
    [practiceId, email, fullName, displayName, initialsFrom(fullName), passwordHash],
  );

  await client.query(`SELECT set_config('luminary.user_id', $1, true)`, [users[0].id]);
  await client.query(
    `SELECT luminary.write_audit('Bootstrapped live practice', 'practice', $1, $2, $3, 'alert')`,
    [practiceId, practiceName, `Initial admin: ${email}`],
  );

  await client.query('COMMIT');
  console.log(`practice=${practiceName}`);
  console.log(`practice_id=${practiceId}`);
  console.log(`admin_email=${email}`);
  console.log('status=ready');
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

function initialsFrom(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? words[words.length - 1]?.[0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}
