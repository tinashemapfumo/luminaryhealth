import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const checksum = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export async function assertSchemaReady(): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const latest = files.at(-1);
  if (!latest) throw new Error('No database migrations were found');

  const sql = await readFile(join(migrationsDir, latest), 'utf8');
  const expectedChecksum = checksum(sql);
  const { rows } = await pool.query(
    `SELECT checksum
       FROM public.schema_migration
      WHERE filename = $1`,
    [latest],
  );
  const applied = rows[0]?.checksum;
  if (!applied) {
    throw new Error(`Database schema is not ready: required migration ${latest} has not been applied`);
  }
  if (applied !== expectedChecksum) {
    throw new Error(`Database schema is not ready: migration ${latest} checksum does not match application code`);
  }
}
