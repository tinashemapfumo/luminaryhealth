import type { Role } from './permissions.js';

/**
 * The authenticated principal, resolved once per request by the auth plugin and
 * read by everything downstream.
 *
 * Every field here comes from the server-side session record, never from a
 * header or body the caller controls. `practiceId` in particular is what gets
 * pushed into the database session and therefore what every row-level security
 * policy compares against — if a client could influence it, the entire tenancy
 * model would be advisory.
 */
export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  practiceId: string;
  role: Role;
  displayName: string;
  /** Set when the practice enforces registration expiry and the user's has lapsed. */
  registrationLapsed: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: AuthenticatedSession;
  }
}
