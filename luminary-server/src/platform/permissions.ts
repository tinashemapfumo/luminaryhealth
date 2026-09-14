import type { FastifyReply, FastifyRequest } from 'fastify';
import { Forbidden, Unauthorized } from './errors.js';
import './session.js';   // augments FastifyRequest with `session`

/**
 * Authorisation.
 *
 * This is the same permission matrix the browser uses, deliberately duplicated
 * rather than imported from it. The client copy decides what to *draw*; this
 * copy decides what is *allowed*. Hiding a button is not access control, and a
 * shared module would invite someone to treat one check as covering both.
 *
 * Keep this file in step with `src/config/access.js` in the frontend. The
 * contract test asserts they agree.
 */

export type Role = 'admin' | 'doctor' | 'nurse' | 'manager' | 'receptionist';

export type Permission =
  | 'viewPatientDirectory' | 'addPatient' | 'editDemographics' | 'editCover'
  | 'scheduleVisit' | 'checkIn'
  | 'viewClinicalNotes' | 'recordVitals' | 'writeNote' | 'signNote' | 'amendNote'
  | 'prescribe' | 'orderLabs' | 'orderServices' | 'editClinicalHistory'
  | 'createInvoice' | 'recordPayment' | 'readClaims' | 'createClaims' | 'editClaims'
  | 'submitClaims' | 'refreshClaimStatus' | 'manageClaimAttachments' | 'viewClaimTransmissions'
  | 'adminClaims' | 'captureBiometric' | 'adjustBalance' | 'manageTariffs'
  | 'sendMessages' | 'manageAgents' | 'exportReports'
  | 'manageUsers' | 'assignRoles' | 'manageConfiguration'
  | 'manageIntegrations' | 'manageCover' | 'reviewAudit';

const NONE: Record<Permission, boolean> = {
  viewPatientDirectory: false, addPatient: false, editDemographics: false, editCover: false,
  scheduleVisit: false, checkIn: false,
  viewClinicalNotes: false, recordVitals: false, writeNote: false, signNote: false, amendNote: false,
  prescribe: false, orderLabs: false, orderServices: false, editClinicalHistory: false,
  createInvoice: false, recordPayment: false, readClaims: false, createClaims: false, editClaims: false,
  submitClaims: false, refreshClaimStatus: false, manageClaimAttachments: false, viewClaimTransmissions: false,
  adminClaims: false, captureBiometric: false, adjustBalance: false, manageTariffs: false,
  sendMessages: false, manageAgents: false, exportReports: false,
  manageUsers: false, assignRoles: false, manageConfiguration: false,
  manageIntegrations: false, manageCover: false, reviewAudit: false,
};

export const rolePermissions: Record<Role, Record<Permission, boolean>> = {
  // Runs the system; does not use it clinically. Cannot see that a patient
  // exists, because provisioning an account never requires reading a chart.
  admin: {
    ...NONE,
    manageUsers: true, assignRoles: true, manageConfiguration: true,
    manageIntegrations: true, manageCover: true, reviewAudit: true,
    manageAgents: true, exportReports: true, viewClaimTransmissions: true, adminClaims: true,
  },
  doctor: {
    ...NONE,
    viewPatientDirectory: true, scheduleVisit: true,
    viewClinicalNotes: true, recordVitals: true, writeNote: true, signNote: true, amendNote: true,
    prescribe: true, orderLabs: true, orderServices: true, editClinicalHistory: true,
    readClaims: true, manageClaimAttachments: true,
    sendMessages: true,
  },
  nurse: {
    ...NONE,
    viewPatientDirectory: true, addPatient: true, editDemographics: true,
    scheduleVisit: true, checkIn: true,
    viewClinicalNotes: true, recordVitals: true, writeNote: true, editClinicalHistory: true,
    orderServices: true, readClaims: true, manageClaimAttachments: true,
    captureBiometric: true, sendMessages: true,
  },
  manager: {
    ...NONE,
    viewPatientDirectory: true, addPatient: true, editDemographics: true, editCover: true,
    scheduleVisit: true, checkIn: true,
    createInvoice: true, recordPayment: true, readClaims: true, createClaims: true, editClaims: true,
    submitClaims: true, refreshClaimStatus: true, manageClaimAttachments: true, viewClaimTransmissions: true,
    adjustBalance: true,
    manageTariffs: true,
    sendMessages: true, manageAgents: true, exportReports: true,
    manageCover: true, reviewAudit: true,
  },
  receptionist: {
    ...NONE,
    viewPatientDirectory: true, addPatient: true, editDemographics: true, editCover: true,
    scheduleVisit: true, checkIn: true,
    createInvoice: true, recordPayment: true, readClaims: true, createClaims: true, editClaims: true,
    submitClaims: true, refreshClaimStatus: true, manageClaimAttachments: true,
    captureBiometric: true,
    sendMessages: true,
  },
};

export const can = (role: Role, permission: Permission): boolean =>
  rolePermissions[role]?.[permission] === true;

/**
 * Route guard.
 *
 * Applied per route rather than globally, so adding an endpoint without
 * deciding its permission is a visible omission rather than a silent default.
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const session = request.session;
    // 401, not 403. The two answer different questions — "I do not know who you
    // are" against "I know, and no" — and a client cannot tell an expired
    // session from a genuine refusal if both arrive as 403. It would leave
    // someone whose session was revoked sitting in a workspace that silently
    // loads nothing, instead of being returned to sign-in.
    if (!session) throw new Unauthorized('Your session has ended. Sign in again.');
    if (!can(session.role, permission)) {
      throw new Forbidden(`Your role does not include: ${permission}`);
    }
  };
}

/**
 * Separation of duty: no one may hand themselves authority they lack. Without
 * this an administrator is one click from granting themselves prescribing
 * rights, and every other boundary becomes advisory.
 */
export function assertCanAssignRole(actorRole: Role, actorId: string, targetId: string, nextRole: Role): void {
  if (actorId === targetId) {
    throw new Forbidden('You cannot change your own role — ask another administrator');
  }
  const granting = rolePermissions[nextRole];
  const held = rolePermissions[actorRole];
  const escalations = (Object.keys(granting) as Permission[]).filter((p) => granting[p] && !held[p]);

  // An administrator legitimately assigns clinical roles they do not hold
  // themselves; what they must not do is route that authority to their own
  // account. The self-check above is the real control, and this records the
  // rest for review.
  if (escalations.length > 0 && actorRole !== 'admin') {
    throw new Forbidden(`You cannot grant permissions you do not hold: ${escalations.join(', ')}`);
  }
}
