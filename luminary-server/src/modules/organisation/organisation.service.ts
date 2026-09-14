import { randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import argon2 from 'argon2';
import { can, rolePermissions, type Permission, type Role } from '../../platform/permissions.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';

/**
 * User accounts and their lifecycle.
 *
 * Two principles run through this module.
 *
 * **Accounts are never deleted.** The audit trail names people, and a record of
 * who did what is worthless if the "who" can be erased. Deactivation revokes
 * every session and blocks sign-in while leaving history intact.
 *
 * **Nobody provisions a credential for someone else.** An administrator issues
 * an invitation; the holder chooses their own password. An admin-set password is
 * a password the admin knows, which makes every action taken by that account
 * deniable.
 */

export interface Actor {
  userId: string;
  role: Role;
  practiceId: string;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const INVITE_TTL_HOURS = 72;

export const organisationService = {
  async listUsers(client: PoolClient, actor: Actor) {
    if (!can(actor.role, 'manageUsers')) throw new Forbidden('Your role cannot view user accounts');

    const { rows } = await client.query(
      `SELECT u.id, u.email, u.full_name, u.display_name, u.job_title, u.role,
              u.registration_number, u.registration_expires, u.is_provider,
              u.active, u.on_leave_until, u.last_seen_at,
              (u.password_hash IS NULL) AS awaiting_first_sign_in,
              (SELECT count(*)::int FROM luminary.session s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS live_sessions,
              (SELECT count(*)::int FROM luminary.patient p
                WHERE p.primary_provider_id = u.id AND p.deleted_at IS NULL) AS patients,
              (SELECT count(*)::int FROM luminary.encounter e
                WHERE e.author_id = u.id AND e.status = 'draft' AND e.deleted_at IS NULL) AS unsigned_notes
         FROM luminary.app_user u
        WHERE u.deleted_at IS NULL
        ORDER BY u.active DESC, u.display_name`,
    );
    return rows;
  },

  /**
   * Invite. Returns the raw token exactly once — only its hash is stored, so a
   * dump of the invitations table cannot be used to claim an account.
   */
  async invite(
    client: PoolClient,
    actor: Actor,
    input: { email: string; role: Role; fullName: string; jobTitle?: string },
  ) {
    if (!can(actor.role, 'manageUsers')) throw new Forbidden('Your role cannot invite users');
    assertMayGrantRole(actor, null, input.role);

    const { rows: existing } = await client.query(
      `SELECT 1 FROM luminary.app_user WHERE email = $1 AND deleted_at IS NULL`, [input.email],
    );
    if (existing.length > 0) throw new Conflict('Someone with that email already has an account here');

    const token = randomBytes(32).toString('base64url');
    const { rows } = await client.query(
      `INSERT INTO luminary.user_invitation
         (practice_id, email, role, invited_by, token_hash, expires_at)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, now() + make_interval(hours => $5))
       RETURNING id, email, role, expires_at`,
      [input.email, input.role, actor.userId, hashToken(token), INVITE_TTL_HOURS],
    );

    await client.query(
      `SELECT luminary.write_audit('Invited user', 'user', NULL, $1, $2, 'notice')`,
      [input.email, `as ${input.role}`],
    );

    // The caller emails this on; the server never stores it in a readable form.
    return { invitation: rows[0], token, fullName: input.fullName, jobTitle: input.jobTitle };
  },

  /**
   * Resolve an invitation token to the practice it belongs to.
   *
   * Runs before any tenant context exists, so it goes through the same
   * SECURITY DEFINER boundary as session resolution — a token carries no
   * practice, and there is nothing to scope to until it is resolved.
   */
  async resolveInvitation(client: PoolClient, token: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.resolve_invitation($1)`, [hashToken(token)],
    );
    if (!rows[0]) throw new NotFound('That invitation is invalid or has expired');

    const { rows: policy } = await client.query(
      `SELECT luminary.password_policy($1) AS min_length`, [rows[0].practice_id],
    );
    return { ...rows[0], minLength: policy[0].min_length as number };
  },

  /**
   * Create the account. Runs inside a transaction scoped to the practice the
   * invitation named, so row-level security still applies to the insert.
   */
  async acceptInvitation(
    client: PoolClient,
    invitation: { invitation_id: string; practice_id: string; email: string; role: Role; minLength: number },
    input: { fullName: string; displayName: string; password: string },
  ) {
    if (input.password.length < invitation.minLength) {
      throw new BadRequest(`Password must be at least ${invitation.minLength} characters`);
    }

    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4,
    });

    const { rows: created } = await client.query(
      `INSERT INTO luminary.app_user
         (practice_id, email, full_name, display_name, role, password_hash, is_provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, display_name, role`,
      [invitation.practice_id, invitation.email, input.fullName, input.displayName,
       invitation.role, passwordHash, invitation.role === 'doctor'],
    );

    await client.query(
      `UPDATE luminary.user_invitation SET accepted_at = now() WHERE id = $1`,
      [invitation.invitation_id],
    );
    await client.query(
      `SELECT set_config('luminary.user_id', $1, true)`, [created[0].id],
    );
    await client.query(
      `SELECT luminary.write_audit('Accepted invitation', 'user', $1, $2, NULL, 'notice')`,
      [created[0].id, created[0].display_name],
    );
    return created[0];
  },

  async setRole(client: PoolClient, actor: Actor, userId: string, role: Role) {
    if (!can(actor.role, 'assignRoles')) throw new Forbidden('Your role cannot assign roles');
    assertMayGrantRole(actor, userId, role);

    const target = await findUser(client, userId);
    const { rows } = await client.query(
      `UPDATE luminary.app_user SET role = $2, is_provider = $3 WHERE id = $1 RETURNING id, display_name, role`,
      [userId, role, role === 'doctor'],
    );

    // A role change alters what existing sessions may do, so they are revoked
    // rather than left carrying stale authority until they expire.
    await client.query(
      `UPDATE luminary.session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId],
    );
    await client.query(
      `SELECT luminary.write_audit('Changed role', 'user', $1, $2, $3, 'notice')`,
      [userId, target.display_name, `${target.role} -> ${role}`],
    );
    return rows[0];
  },

  async setActive(client: PoolClient, actor: Actor, userId: string, active: boolean) {
    if (!can(actor.role, 'manageUsers')) throw new Forbidden('Your role cannot deactivate accounts');
    if (userId === actor.userId) throw new Forbidden('You cannot deactivate your own account');

    const target = await findUser(client, userId);

    if (!active) {
      const blockers = await offboardingBlockers(client, userId);
      if (blockers.unsignedNotes > 0) {
        throw new Conflict(
          `${target.display_name} has ${blockers.unsignedNotes} unsigned note(s). ` +
          'Reassign or resolve them before deactivating — an unsigned note by a departed clinician ' +
          'cannot be signed by anyone afterwards.',
        );
      }
    }

    const { rows } = await client.query(
      `UPDATE luminary.app_user SET active = $2 WHERE id = $1 RETURNING id, display_name, active`,
      [userId, active],
    );
    if (!active) {
      await client.query(
        `UPDATE luminary.session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId],
      );
    }
    await client.query(
      `SELECT luminary.write_audit($1, 'user', $2, $3, NULL, 'notice')`,
      [active ? 'Reactivated user' : 'Deactivated user', userId, target.display_name],
    );
    return rows[0];
  },

  /**
   * What stands between this clinician and the door.
   *
   * Offboarding is a workflow rather than a checkbox: a departing doctor leaves
   * behind a patient list that needs an owner and, worse, unsigned notes that
   * nobody else can ever sign. Surfacing both before deactivation is the whole
   * point.
   */
  async offboardingReport(client: PoolClient, actor: Actor, userId: string) {
    if (!can(actor.role, 'manageUsers')) throw new Forbidden('Your role cannot view offboarding');
    const target = await findUser(client, userId);
    const blockers = await offboardingBlockers(client, userId);
    return {
      user: { id: target.id, name: target.display_name, role: target.role },
      ...blockers,
      canDeactivate: blockers.unsignedNotes === 0,
      guidance: blockers.unsignedNotes > 0
        ? 'Unsigned notes must be completed or formally abandoned first — once the account is closed nobody can sign them.'
        : blockers.patients > 0
          ? 'Reassign the patient list so those patients still have a named clinician.'
          : 'Nothing outstanding.',
    };
  },

  /** Moves a departing clinician's patients to a colleague, in one auditable act. */
  async reassignPatients(client: PoolClient, actor: Actor, fromUserId: string, toUserId: string) {
    if (!can(actor.role, 'manageUsers')) throw new Forbidden('Your role cannot reassign patients');
    if (fromUserId === toUserId) throw new BadRequest('Choose a different clinician');

    const [from, to] = await Promise.all([findUser(client, fromUserId), findUser(client, toUserId)]);
    if (to.role !== 'doctor') throw new BadRequest(`${to.display_name} is not a clinician`);
    if (!to.active) throw new BadRequest(`${to.display_name} is deactivated`);

    const { rowCount } = await client.query(
      `UPDATE luminary.patient SET primary_provider_id = $2
        WHERE primary_provider_id = $1 AND deleted_at IS NULL`,
      [fromUserId, toUserId],
    );
    await client.query(
      `SELECT luminary.write_audit('Reassigned patient list', 'user', $1, $2, $3, 'notice')`,
      [fromUserId, from.display_name, `${rowCount} patient(s) to ${to.display_name}`],
    );
    return { moved: rowCount ?? 0, from: from.display_name, to: to.display_name };
  },

  /** Ends every session for a user — the reason sessions are server-side. */
  async revokeSessions(client: PoolClient, actor: Actor, userId: string) {
    if (!can(actor.role, 'manageUsers')) throw new Forbidden('Your role cannot revoke sessions');
    const target = await findUser(client, userId);
    const { rowCount } = await client.query(
      `UPDATE luminary.session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId],
    );
    await client.query(
      `SELECT luminary.write_audit('Revoked all sessions', 'user', $1, $2, NULL, 'alert')`,
      [userId, target.display_name],
    );
    return { revoked: rowCount ?? 0 };
  },

  /** Registrations lapsing soon — a lapsed clinician cannot sign or prescribe. */
  async expiringRegistrations(client: PoolClient, actor: Actor, withinDays = 60) {
    if (!can(actor.role, 'manageUsers')) throw new Forbidden('Your role cannot view registrations');
    const { rows } = await client.query(
      `SELECT id, display_name, registration_number, registration_expires,
              (registration_expires < current_date) AS already_lapsed
         FROM luminary.app_user
        WHERE active AND deleted_at IS NULL
          AND registration_expires IS NOT NULL
          AND registration_expires <= current_date + $1::int
        ORDER BY registration_expires`,
      [withinDays],
    );
    return rows;
  },
};

async function findUser(client: PoolClient, id: string) {
  const { rows } = await client.query(
    `SELECT id, display_name, role, active FROM luminary.app_user WHERE id = $1 AND deleted_at IS NULL`, [id],
  );
  if (!rows[0]) throw new NotFound('User not found');
  return rows[0];
}

async function offboardingBlockers(client: PoolClient, userId: string) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM luminary.patient p
         WHERE p.primary_provider_id = $1 AND p.deleted_at IS NULL) AS patients,
       (SELECT count(*)::int FROM luminary.encounter e
         WHERE e.author_id = $1 AND e.status = 'draft' AND e.deleted_at IS NULL) AS unsigned_notes,
       (SELECT count(*)::int FROM luminary.appointment a
         WHERE a.provider_id = $1 AND a.deleted_at IS NULL
           AND a.starts_at > now() AND a.status = 'booked') AS upcoming_appointments`,
    [userId],
  );
  return {
    patients: rows[0].patients as number,
    unsignedNotes: rows[0].unsigned_notes as number,
    upcomingAppointments: rows[0].upcoming_appointments as number,
  };
}

/**
 * Separation of duty.
 *
 * The self-check is the real control: an administrator legitimately assigns
 * clinical roles they do not hold, but must never route that authority to their
 * own account. Without this, every other boundary is one click from advisory.
 */
function assertMayGrantRole(actor: Actor, targetId: string | null, role: Role): void {
  if (targetId && targetId === actor.userId) {
    throw new Forbidden('You cannot change your own role — ask another administrator');
  }
  if (actor.role === 'admin') return;

  const granting = rolePermissions[role];
  const held = rolePermissions[actor.role];
  const escalations = (Object.keys(granting) as Permission[]).filter((p) => granting[p] && !held[p]);
  if (escalations.length > 0) {
    throw new Forbidden(`You cannot grant permissions you do not hold: ${escalations.join(', ')}`);
  }
}
