import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { authRepository, type UserRow } from './auth.repository.js';
import { Unauthorized } from '../../platform/errors.js';
import { config } from '../../platform/config.js';
import type { AuthenticatedSession } from '../../platform/session.js';

/**
 * Authentication.
 *
 * Three deliberate choices:
 *
 * 1. The token the client holds is random, and only its SHA-256 is stored. A
 *    dump of the session table therefore cannot be replayed. The token is
 *    opaque — not a JWT — because a session must be revocable the moment a
 *    laptop goes missing from a clinic, and a stateless token cannot be.
 *
 * 2. Failures are indistinguishable. Unknown email, wrong password, wrong
 *    practice, and deactivated account all return the same message and all pay
 *    the same hashing cost, so the endpoint cannot be used to enumerate staff.
 *
 * 3. A lapsed practising registration does not block sign-in — it blocks
 *    signing and prescribing. Locking a clinician out of the record entirely
 *    because their council renewal is late would be worse for patients than the
 *    problem it solves.
 */

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Cost of a real verification, paid even when the user does not exist. */
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

export const authService = {
  async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
  },

  async signIn(
    client: PoolClient,
    input: { practiceId: string; email: string; password: string; ip?: string; userAgent?: string },
  ): Promise<{ token: string; session: AuthenticatedSession; expiresAt: Date }> {
    const user: UserRow | null = await authRepository.findUser(client, input.practiceId, input.email);

    // Always verify against something so timing does not reveal existence.
    const hash = user?.password_hash ?? DUMMY_HASH;
    let ok = false;
    try {
      ok = await argon2.verify(hash, input.password);
    } catch {
      ok = false;
    }

    if (!user || !ok || !user.active) {
      throw new Unauthorized('Those details do not match an account');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);

    const { id: sessionId } = await authRepository.createSession(client, {
      practiceId: user.practice_id,
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    // The transaction is already scoped to the claimed practice; supply the
    // user so the audit entry is attributed rather than anonymous.
    await client.query(`SELECT set_config('luminary.user_id', $1, true)`, [user.id]);
    await client.query(`SELECT luminary.write_audit('Signed in', 'user', $1, $2, $3, 'info')`, [
      user.id, user.display_name, `${user.role}`,
    ]);

    return {
      token,
      expiresAt,
      session: {
        sessionId,
        userId: user.id,
        practiceId: user.practice_id,
        role: user.role,
        displayName: user.display_name,
        registrationLapsed: isRegistrationLapsed(user.registration_expires),
      },
    };
  },

  /** Resolves a bearer token. Returns null rather than throwing so the caller
   *  decides whether the route needed authentication at all. */
  async resolve(client: PoolClient, token: string): Promise<AuthenticatedSession | null> {
    const row = await authRepository.findSession(client, hashToken(token));
    if (!row || !row.active) return null;

    return {
      sessionId: row.session_id,
      userId: row.user_id,
      practiceId: row.practice_id,
      role: row.role,
      displayName: row.display_name,
      registrationLapsed:
        row.enforce_registration !== false && isRegistrationLapsed(row.registration_expires),
    };
  },

  /**
   * Confirm a password for a user who is already signed in.
   *
   * Used by the lock screen, which is a different question from sign-in: the
   * identity is already established, so there is nothing to enumerate and no
   * dummy hash to pay. A user without a password hash — invited but never
   * activated — cannot unlock, which is correct: they have no password to give.
   */
  async verifyPassword(
    client: PoolClient,
    practiceId: string,
    userId: string,
    password: string,
  ): Promise<boolean> {
    const { rows } = await client.query<{ password_hash: string | null; active: boolean }>(
      `SELECT password_hash, active FROM luminary.app_user
        WHERE id = $1 AND practice_id = $2 AND deleted_at IS NULL`,
      [userId, practiceId],
    );
    const user = rows[0];
    if (!user?.password_hash || !user.active) return false;
    try {
      return await argon2.verify(user.password_hash, password);
    } catch {
      return false;
    }
  },

  async signOut(client: PoolClient, token: string): Promise<void> {
    await authRepository.revokeSession(client, hashToken(token));
  },
};

function isRegistrationLapsed(expires: string | null): boolean {
  if (!expires) return false;
  return new Date(expires) < new Date();
}

/** Constant-time compare for anywhere a secret is checked outside argon2. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
