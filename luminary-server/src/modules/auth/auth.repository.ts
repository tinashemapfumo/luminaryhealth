import type { PoolClient } from 'pg';

/**
 * Identity lookups.
 *
 * These run OUTSIDE a tenant context on purpose: at sign-in the practice is not
 * yet known — resolving it is the point of the exercise. Every query therefore
 * filters `practice_id` explicitly, which is the one place in the codebase
 * where doing so is correct rather than redundant.
 */

export interface UserRow {
  id: string;
  practice_id: string;
  email: string;
  full_name: string;
  display_name: string;
  role: 'admin' | 'doctor' | 'nurse' | 'manager' | 'receptionist';
  password_hash: string | null;
  registration_expires: string | null;
  active: boolean;
}

export const authRepository = {
  /** Scoped by practice because the caller states which practice they belong to. */
  async findUser(client: PoolClient, practiceId: string, email: string): Promise<UserRow | null> {
    const { rows } = await client.query<UserRow>(
      `SELECT id, practice_id, email, full_name, display_name, role,
              password_hash, registration_expires, active
         FROM luminary.app_user
        WHERE practice_id = $1 AND email = $2 AND deleted_at IS NULL`,
      [practiceId, email],
    );
    return rows[0] ?? null;
  },

  async createSession(
    client: PoolClient,
    input: { practiceId: string; userId: string; tokenHash: string; expiresAt: Date; ip?: string; userAgent?: string },
  ): Promise<{ id: string }> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO luminary.session (practice_id, user_id, token_hash, expires_at, ip, user_agent, origin_node)
       VALUES ($1, $2, $3, $4, $5, $6, current_setting('luminary.node', true))
       RETURNING id`,
      [input.practiceId, input.userId, input.tokenHash, input.expiresAt, input.ip ?? null, input.userAgent ?? null],
    );
    return rows[0]!;
  },

  /**
   * Resolves a bearer token. Goes through `resolve_session`, the one
   * SECURITY DEFINER function permitted to read across tenants — a token
   * carries no practice, so there is nothing to scope to until it is resolved.
   */
  async findSession(client: PoolClient, tokenHash: string) {
    const { rows } = await client.query(`SELECT * FROM luminary.resolve_session($1)`, [tokenHash]);
    return rows[0] ?? null;
  },

  async revokeSession(client: PoolClient, tokenHash: string): Promise<void> {
    await client.query(`SELECT luminary.revoke_session($1)`, [tokenHash]);
  },

  /** "Sign out everywhere" — the reason sessions are server-side at all. */
  async revokeAllForUser(client: PoolClient, userId: string): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE luminary.session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return rowCount ?? 0;
  },
};
