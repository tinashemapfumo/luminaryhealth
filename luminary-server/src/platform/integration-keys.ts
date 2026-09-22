import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * The credential and signing rules for machine callers.
 *
 * Deliberately free of database and configuration imports, so the rules that
 * decide whether a webhook is authentic can be exercised on their own. The
 * Fastify guard that uses them lives in `integration.ts` and needs a database;
 * these do not, and a security rule that cannot be tested without one tends not
 * to be tested.
 *
 * The scheme is HMAC over the raw body, the same one the outbound dispatcher
 * already uses in the other direction. Three headers:
 *
 *   x-luminary-key         which credential is calling — identifies, never authenticates
 *   x-luminary-timestamp   when it was signed, to bound replay
 *   x-luminary-signature   hex HMAC-SHA256 of `timestamp.body` with the signing key
 *
 * The timestamp is *inside* the signed material on purpose. Signing the body
 * alone would let anyone who captured one valid request replay it for ever — a
 * captured reminder resent nightly is a nuisance, a captured inbound message
 * replayed into a patient's record is not.
 */

export const INTEGRATION_SCOPES = [
  'messaging:inbound',
  'messaging:status',
  'messaging:send',
  // An assistant holding a conversation with a patient. Split so a workflow
  // that only books cannot also gather record changes, and neither can read
  // anything a delivery-receipt flow would.
  'agent:converse',
  'agent:schedule',
  'agent:intake',
  'agent:status',
  'agent:followup',
  // Read-only, aggregate management reporting for Executive Insight.
  'agent:insight',
  // Canonical v1 reporting scope. agent:insight remains a compatibility scope.
  'agent:report',
  'claims:status',
] as const;

export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

/** How far a caller's clock may drift before a request is refused. */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export const hashSecret = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');

/**
 * A new credential.
 *
 * The secret is returned once and stored only as a hash — the rule a password
 * follows, for the same reason: a stolen backup must not yield a working key.
 * A practice that mislays it rotates rather than recovers.
 */
export function mintCredential() {
  const keyId = `lmk_${randomBytes(9).toString('base64url')}`;
  const secret = randomBytes(32).toString('base64url');
  return { keyId, secret, secretHash: hashSecret(secret) };
}

export const signRequest = (signingKey: string, timestamp: string, body: string) =>
  createHmac('sha256', signingKey).update(`${timestamp}.${body}`).digest('hex');

/**
 * What an administrator pastes into the workflow as its signing key.
 *
 * The hash rather than the secret, because the server keeps only the hash and
 * an HMAC needs both sides to hold the same key. A deliberate trade: the
 * database stays useless to a thief, at the cost of the signing key being a
 * value derived from the secret — which is only ever known to whoever already
 * had the secret, so nothing is given away.
 */
export const integrationSigningKey = (secret: string) => hashSecret(secret);

/** Constant-time: a leaky comparison gives up a signature a byte at a time. */
export function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify a request against the signing key derived from the stored hash. */
export const verifyRequest = (
  storedSecretHash: string, timestamp: string, body: string, provided: string,
) => signatureMatches(signRequest(storedSecretHash, timestamp, body), provided);

/** Is this timestamp close enough to now to be worth verifying? */
export const withinSkew = (timestamp: string, now = Date.now()) => {
  const signedAt = Number(timestamp);
  return Number.isFinite(signedAt) && Math.abs(now - signedAt) <= MAX_SKEW_MS;
};
