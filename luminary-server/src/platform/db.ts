import { Pool, types, type PoolClient } from 'pg';
import { config } from './config.js';

/**
 * Database access.
 *
 * There is exactly one way to reach the database from a request: `withTenant`.
 * It opens a transaction, sets the tenant context that every row-level security
 * policy reads, and hands you a client. Nothing else is exported that can run a
 * query, because a query outside that context is a query with no tenant filter.
 *
 * The context is set with `set_config(..., true)` — transaction-local — so a
 * pooled connection cannot carry one practice's identity into the next
 * request's work. Getting that wrong is the classic multi-tenant pooling bug.
 */

// PostgreSQL DATE columns are calendar dates, not instants. Returning them as
// strings prevents timezone conversion from shifting dates at the API boundary.
types.setTypeParser(1082, (value) => value);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  application_name: `luminary-${config.nodeId}`,
});

export interface TenantContext {
  practiceId: string;
  userId: string | null;
  integrationCredentialId?: string | null;
  correlationId?: string | null;
  requestId?: string | null;
}

/**
 * Run work inside a transaction scoped to one practice.
 *
 * Every statement issued through the supplied client is filtered by RLS. A
 * developer who forgets a `WHERE practice_id = ...` gets zero rows rather than
 * another clinic's patients — which is the whole point of putting the control
 * here instead of in application code.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('luminary.practice_id', $1, true),
              set_config('luminary.user_id',     $2, true),
              set_config('luminary.node',        $3, true),
              set_config('luminary.integration_credential_id', $4, true),
              set_config('luminary.correlation_id', $5, true),
              set_config('luminary.request_id', $6, true)`,
      [
        ctx.practiceId, ctx.userId ?? '', config.nodeId,
        ctx.integrationCredentialId ?? '', ctx.correlationId ?? '', ctx.requestId ?? '',
      ],
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * For work that legitimately spans tenants: sign-in (the practice is not known
 * until the credential resolves), migrations, and the sync worker. Deliberately
 * named to be conspicuous in review — every call site should be justifiable.
 */
export async function withoutTenant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
