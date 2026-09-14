import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withoutTenant, withTenant } from '../../platform/db.js';
import { authService } from './auth.service.js';
import { Unauthorized } from '../../platform/errors.js';

const signInBody = z.object({
  // Stated explicitly rather than inferred from the account, so a wrong-tenant
  // sign-in fails loudly instead of dropping someone into another clinic.
  practiceId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/session', async (request, reply) => {
    const body = signInBody.parse(request.body);

    // The caller states which practice they are signing in to, so the lookup
    // is scoped to it and row-level security still applies. Claiming the wrong
    // practice simply finds no user — the client is choosing what to scope to,
    // not what it may access, and the password check still has to pass.
    const result = await withTenant(
      { practiceId: body.practiceId, userId: null },
      (client) =>
        authService.signIn(client, {
          ...body,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        }),
    );

    return reply.code(201).send({
      token: result.token,
      expiresAt: result.expiresAt,
      user: {
        id: result.session.userId,
        name: result.session.displayName,
        role: result.session.role,
        practiceId: result.session.practiceId,
        registrationLapsed: result.session.registrationLapsed,
      },
    });
  });

  /**
   * The practices a user may sign in to.
   *
   * Public, and deliberately so: sign-in requires naming a practice, so the
   * picker has to be populated before anyone is authenticated. The trade is
   * narrow and worth stating — a clinic's name and city are already on its
   * front door, whereas *who works there* is not, and that is why this returns
   * neither users nor counts nor settings.
   *
   * On a practice's local server this is a list of one. On cloud it is every
   * practice, which is the honest limit of this approach: a large multi-tenant
   * deployment should serve each practice its own sign-in host instead, and
   * then this endpoint filters to that host rather than listing.
   */
  app.get('/practices', async () =>
    withoutTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, short_name, city, plan
           FROM luminary.practice
          WHERE deleted_at IS NULL
          ORDER BY name`,
      );
      return rows;
    }),
  );

  app.delete('/auth/session', async (request, reply) => {
    const token = bearer(request.headers.authorization);
    if (token) await withoutTenant((client) => authService.signOut(client, token));
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request) => {
    if (!request.session) throw new Unauthorized();
    const s = request.session;
    return withTenant({ practiceId: s.practiceId, userId: s.userId }, async (client) => {
      // Everything the workspace needs to render a signed-in principal, in one
      // call: the client restores a session on reload from this alone, so a
      // second round trip for the practice or the job title would just be a
      // slower first paint.
      const { rows } = await client.query(
        `SELECT u.id, u.display_name, u.full_name, u.email, u.initials, u.job_title,
                u.role, u.registration_number, u.registration_expires, u.is_provider,
                p.id AS practice_id, p.name AS practice_name, p.short_name AS practice_short,
                p.city AS practice_city, p.plan AS practice_plan
           FROM luminary.app_user u
           JOIN luminary.practice p ON p.id = u.practice_id
          WHERE u.id = $1`,
        [s.userId],
      );
      const row = rows[0];
      if (!row) throw new Unauthorized();

      return {
        user: {
          id: row.id,
          name: row.display_name,
          fullName: row.full_name,
          email: row.email,
          // Derived here rather than stored twice: a user seeded without
          // initials should still render an avatar, not an empty square.
          // `??` is not enough: the seed stores an empty string rather than
          // NULL for a user with no initials, which would render a blank avatar.
          initials: row.initials || initialsFrom(row.full_name),
          jobTitle: row.job_title,
          role: row.role,
          practiceId: row.practice_id,
          registration: row.registration_number,
          isProvider: row.is_provider,
          registrationLapsed: s.registrationLapsed,
        },
        practice: {
          id: row.practice_id,
          name: row.practice_name,
          short: row.practice_short,
          location: row.practice_city,
          plan: row.practice_plan,
        },
      };
    });
  });

  /**
   * Re-enter the password to lift an idle lock.
   *
   * Deliberately *not* a fresh sign-in: the session continues, so a locked
   * workstation is a pause rather than a logout with its state thrown away.
   * The token must still be valid — a lock that outlives its session must send
   * the user back to sign-in, or the lock screen becomes a way to extend a
   * session indefinitely by never using it.
   *
   * A wrong password is audited. Someone guessing at an unattended machine in a
   * clinic corridor is exactly the event this whole lock exists for.
   */
  app.post('/auth/unlock', async (request) => {
    if (!request.session) throw new Unauthorized();
    const { password } = z.object({ password: z.string().min(1) }).parse(request.body);
    const s = request.session;

    // The audit write and the throw are deliberately separated. Throwing inside
    // `withTenant` rolls the transaction back — including the audit entry, which
    // is the one thing that must survive a failed attempt. So the transaction
    // records what happened and returns normally; the refusal happens after it
    // has committed.
    const ok = await withTenant({ practiceId: s.practiceId, userId: s.userId }, async (client) => {
      const verified = await authService.verifyPassword(client, s.practiceId, s.userId, password);
      await client.query(
        `SELECT luminary.write_audit($1, 'user', $2, $3, $4, $5)`,
        verified
          ? ['Session unlocked', s.userId, s.displayName, null, 'info']
          : ['Failed unlock attempt', s.userId, s.displayName,
             'Wrong password at a locked workstation', 'alert'],
      );
      return verified;
    });

    if (!ok) throw new Unauthorized('That password does not match');
    return { unlocked: true };
  });
}

/** "Dr. Mei Chen" → "MC". First and last word, so a middle name is ignored. */
function initialsFrom(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter((w) => !/^(dr|mr|mrs|ms|prof|sr)\.?$/i.test(w));
  const first = words[0] ?? fullName;
  const last = words.length > 1 ? words[words.length - 1]! : "";
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

export const bearer = (header?: string): string | null => {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
};
