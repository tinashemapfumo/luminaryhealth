import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Migration runner.
 *
 * Deliberately small and boring. Files run once, in filename order, each inside
 * its own transaction, with a hash recorded so an already-applied file that has
 * since been edited is caught rather than silently ignored — the failure mode
 * where two environments diverge and nobody notices until production behaves
 * differently.
 *
 * Runs as the migration role, not the application role, because the API is not
 * permitted to alter its own schema.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const hash = async (text: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
};

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL (or MIGRATION_DATABASE_URL) first.');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename    text PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await client.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM public.schema_migration',
  );
  const seen = new Map(applied.map((r) => [r.filename, r.checksum]));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const filename of files) {
    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    const checksum = await hash(sql);
    const previous = seen.get(filename);

    if (previous) {
      if (previous !== checksum) {
        console.error(
          `\n  ${filename} has changed since it was applied.\n` +
          '  Applied migrations are immutable — add a new file instead.\n',
        );
        process.exit(1);
      }
      continue;
    }

    process.stdout.write(`  ${filename} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO public.schema_migration (filename, checksum) VALUES ($1, $2)',
        [filename, checksum],
      );
      await client.query('COMMIT');
      console.log('ok');
      ran += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      console.error(`\n${(error as Error).message}\n`);
      await client.end();
      process.exit(1);
    }
  }

  console.log(ran === 0 ? '\n  Already up to date.\n' : `\n  Applied ${ran} migration(s).\n`);
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
