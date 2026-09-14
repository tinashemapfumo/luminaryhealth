import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTenant, withoutTenant } from './db.js';
import { Forbidden, Unauthorized } from './errors.js';
import { verifyRequest, withinSkew, type IntegrationScope } from './integration-keys.js';

export {
  INTEGRATION_SCOPES, mintCredential, hashSecret, signRequest, integrationSigningKey,
  type IntegrationScope,
} from './integration-keys.js';

/**
 * Authenticating a machine.
 *
 * n8n is not a user. It has no session, no role, no care relationship, and
 * nobody is sitting behind it to notice something went wrong — so it gets a
 * credential of its own rather than an account, and that credential carries
 * *scopes* rather than a role. Giving a workflow a role would mean every
 * permission later granted to that role silently extends to a webhook.
 *
 * The signing rules live in `integration-keys.ts`, which has no database
 * imports so they can be verified directly. This file is only the guard.
 */
export interface IntegrationCaller {
  credentialId: string;
  practiceId: string;
  name: string;
  scopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    integration?: IntegrationCaller;
    rawBody?: string;
  }
}

/**
 * Guard a route for a machine caller holding a given scope.
 *
 * Resolves the credential outside tenancy — it has to, since the practice is
 * what the credential *establishes* — and everything downstream then runs
 * inside that practice's scope. A webhook can therefore never reach another
 * practice's data even if its payload names one.
 */
export function requireIntegration(scope: IntegrationScope) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const keyId = request.headers['x-luminary-key'];
    const timestamp = request.headers['x-luminary-timestamp'];
    const signature = request.headers['x-luminary-signature'];

    if (typeof keyId !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
      throw new Unauthorized('Signed integration headers are required');
    }

    if (!withinSkew(timestamp)) {
      // Also the answer when a workflow's clock is simply wrong, which is why
      // this says so rather than only "unauthorised".
      throw new Unauthorized('Request timestamp is outside the accepted window — check the workflow clock');
    }

    const credential = await withoutTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT id, practice_id, name, scopes, secret_hash, active, expires_at
           FROM luminary.lookup_integration_credential($1)`,
        [keyId],
      );
      return rows[0] ?? null;
    });

    // One message for "no such key", "revoked" and "wrong signature". Telling a
    // caller which of the three it was tells an attacker which keys exist.
    const refuse = (): never => { throw new Unauthorized('Integration credentials rejected'); };

    if (!credential) {
      request.log.warn({ reason: 'credential_not_found' }, 'integration credential rejected');
      refuse();
    }
    if (!credential.active) {
      request.log.warn({ reason: 'credential_revoked', credentialId: credential.id }, 'integration credential rejected');
      refuse();
    }
    if (credential.expires_at && new Date(credential.expires_at) < new Date()) {
      request.log.warn({ reason: 'credential_expired', credentialId: credential.id }, 'integration credential rejected');
      refuse();
    }
    if (!verifyRequest(credential.secret_hash, timestamp, request.rawBody ?? '', signature)) {
      request.log.warn({ reason: 'signature_invalid', credentialId: credential.id }, 'integration credential rejected');
      refuse();
    }

    if (!credential.scopes.includes(scope)) {
      request.log.warn({ reason: 'scope_missing', credentialId: credential.id, scope }, 'integration credential rejected');
      throw new Forbidden(`This integration credential does not include ${scope}`);
    }

    request.integration = {
      credentialId: credential.id,
      practiceId: credential.practice_id,
      name: credential.name,
      scopes: credential.scopes,
    };

    // Best effort. Knowing a credential is unused is a nice-to-have; dropping a
    // patient's reply because a bookkeeping update failed is not.
    void withTenant({ practiceId: credential.practice_id, userId: null }, (client) =>
      client.query(
        `UPDATE luminary.integration_credential SET last_used_at = now() WHERE id = $1`,
        [credential.id],
      ),
    ).catch(() => undefined);
  };
}
