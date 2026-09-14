import pg from 'pg';

const DB = process.env.DATABASE_URL || 'postgres://postgres:dev@localhost:55433/luminary';

const placeholders = ['unknown', 'n/a', 'na', 'none', 'not provided', 'not available'];

const pool = new pg.Pool({ connectionString: DB });

try {
  const { rows } = await pool.query(
    `SELECT p.practice_id,
            pr.short_name AS practice,
            p.id,
            p.reference,
            p.full_name,
            p.national_id,
            p.created_at
       FROM luminary.patient p
       JOIN luminary.practice pr ON pr.id = p.practice_id
      WHERE p.deleted_at IS NULL
        AND p.national_id IS NOT NULL
        AND lower(btrim(p.national_id)) = ANY($1::text[])
      ORDER BY pr.short_name, p.created_at DESC`,
    [placeholders],
  );

  if (rows.length === 0) {
    console.log('No suspicious placeholder national IDs found.');
  } else {
    console.table(rows.map((row) => ({
      practice: row.practice,
      practice_id: row.practice_id,
      patient_id: row.id,
      reference: row.reference,
      full_name: row.full_name,
      national_id: row.national_id,
      created_at: row.created_at,
    })));
    console.log(`${rows.length} suspicious placeholder national ID candidate(s). Review manually before cleanup.`);
  }
} finally {
  await pool.end();
}
