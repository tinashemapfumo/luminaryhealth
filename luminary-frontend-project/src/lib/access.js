import { RELATIONSHIP, AUDIT } from '../data/organisation';

/**
 * Who may see which patient, and on what grounds.
 *
 * Access is layered, and the layers are deliberately independent:
 *
 *   1. Tenant       — which practice. Absolute; nothing crosses it, ever.
 *   2. Role         — what kind of action (the PERMISSIONS matrix).
 *   3. Relationship — which patients those actions apply to. This file.
 *   4. Break-glass  — a logged, reasoned exception to layer 3.
 *
 * Layer 3 is intentionally permissive about *reading*. Hard-denying a
 * clinician access to a chart is dangerous: the covering doctor, the locum,
 * and the emergency at 2am all need a way through. Real clinical systems rely
 * on accountability rather than prevention — you may open any chart in your
 * practice, but doing so outside a care relationship is challenged, reasoned,
 * and permanently logged. The deterrent is that everyone can see you looked.
 */

/** A relationship is live if it has no expiry or the expiry is in the future. */
const isLive = (until) => !until || new Date(until) >= new Date();

/**
 * Why this user may see this patient, or null if there is no standing reason.
 * Returns the strongest relationship found.
 */
export function careRelationship(user, patient, context = {}) {
  if (!user || !patient) return null;
  if (user.practiceId !== patient.practiceId) return null; // tenant boundary

  const { appointments = [], notes = [], grants = [] } = context;

  if (patient.provider === user.name) {
    return { type: RELATIONSHIP.PRIMARY, detail: 'You are the primary provider' };
  }

  const grant = grants.find(
    (g) => g.userId === user.id && g.patientId === patient.id && isLive(g.until)
  );
  if (grant) {
    return {
      type: grant.type === 'Break-glass' ? RELATIONSHIP.BREAK_GLASS : RELATIONSHIP.GRANT,
      detail: grant.reason,
      until: grant.until,
      grant,
    };
  }

  if (appointments.some((a) => a.patient === patient.name && a.provider === user.name)) {
    return { type: RELATIONSHIP.APPOINTMENT, detail: 'Booked into your clinic' };
  }

  if (notes.some((n) => n.patientId === patient.id && n.provider === user.name)) {
    return { type: RELATIONSHIP.AUTHOR, detail: 'You authored a note for this patient' };
  }

  return null;
}

/**
 * Patients inside the user's practice. This is the searchable universe —
 * never other practices' patients.
 */
export function patientsInPractice(user, patients) {
  if (!user) return [];
  return patients.filter((p) => p.practiceId === user.practiceId);
}

/**
 * The user's own list. Roles without `ownPatientsOnly` (nurses, managers,
 * admins) work across the whole practice by design — a nurse serves every
 * doctor, and reception books for all of them.
 */
export function patientsInCare(user, patients, access, context) {
  const inPractice = patientsInPractice(user, patients);
  if (!access?.ownPatientsOnly) return inPractice;
  return inPractice.filter((p) => careRelationship(user, p, context) !== null);
}

/**
 * Decide what happens when a chart is opened.
 *  - 'allow'        a standing relationship exists
 *  - 'break-glass'  same practice, no relationship — challenge and log
 *  - 'deny'         different practice; not offerable at any price
 */
export function chartAccess(user, patient, access, context) {
  if (!user || !patient) return { decision: 'deny', reason: 'Unknown patient' };
  if (user.practiceId !== patient.practiceId) {
    return { decision: 'deny', reason: 'This patient belongs to another practice' };
  }
  if (!access?.ownPatientsOnly) {
    return { decision: 'allow', relationship: { type: 'Practice staff', detail: `${access?.label || 'Staff'} access` } };
  }
  const relationship = careRelationship(user, patient, context);
  if (relationship) return { decision: 'allow', relationship };
  return { decision: 'break-glass', reason: 'No care relationship with this patient' };
}

/** A break-glass grant expires the same day; it is an exception, not a transfer. */
export function makeBreakGlassGrant({ user, patient, reason }) {
  const until = new Date();
  until.setHours(23, 59, 59, 999);
  return {
    id: `GRANT-BG-${Date.now().toString(36).toUpperCase()}`,
    practiceId: user.practiceId,
    userId: user.id,
    patientId: patient.id,
    type: 'Break-glass',
    reason,
    grantedBy: user.name,
    until: until.toISOString(),
  };
}

let auditSequence = 0;

/** Audit entries are append-only; nothing in the UI may edit or remove one. */
export function auditEntry({ user, action, subject, detail, severity = AUDIT.INFO }) {
  auditSequence += 1;
  return {
    id: `AUD-${Date.now().toString(36).toUpperCase()}-${auditSequence}`,
    at: new Date().toISOString(),
    practiceId: user?.practiceId || null,
    userId: user?.id || null,
    userName: user?.name || 'Unknown',
    role: user?.role || null,
    action,
    subject: subject || '',
    detail: detail || '',
    severity,
  };
}

export const formatAuditTime = (iso) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
