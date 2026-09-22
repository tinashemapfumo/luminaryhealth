/**
 * Service surface.
 *
 * Every mutation the workspace performs, named once, with the endpoint that
 * will implement it. Today the shell calls React setters directly; this module
 * is the agreed shape those calls migrate to, and — read as a table — it is the
 * backend specification. Building the frontend first discovered the domain
 * model; this writes it down so the server implements it rather than reinvents it.
 *
 * Three rules the server must honour, none of which the client can enforce:
 *
 *  1. **Tenant scoping happens in the query.** Every endpoint below is implicitly
 *     `WHERE practice_id = :caller_practice`. The client filtering in
 *     `lib/access.js` is a convenience, not a control.
 *  2. **Permissions are re-checked server-side.** `config/access.js` is the same
 *     matrix, but hiding a button is not access control.
 *  3. **Audit writes are not optional and not client-supplied.** The server
 *     records who called what, from the authenticated principal — never from a
 *     field in the request body.
 */

export const ENDPOINTS = {
  auth: {
    signIn: { method: 'POST', path: '/auth/session', body: ['practiceId', 'email', 'password'], returns: 'session + user' },
    signOut: { method: 'DELETE', path: '/auth/session' },
    unlock: { method: 'POST', path: '/auth/unlock', body: ['password'] },
    me: { method: 'GET', path: '/auth/me' },
  },

  patients: {
    list: { method: 'GET', path: '/patients', query: ['search', 'scope'], note: 'scope=mine|practice' },
    get: { method: 'GET', path: '/patients/:id', note: '403 unless a care relationship or an active break-glass grant exists' },
    create: { method: 'POST', path: '/patients', permission: 'addPatient', note: 'national ID may be null; probable duplicates require acknowledgement' },
    update: { method: 'PATCH', path: '/patients/:id', permission: 'editDemographics | editCover | editClinicalHistory', note: 'field groups are separately permissioned' },
    correctIdentity: { method: 'POST', path: '/patients/:id/identity-corrections', permission: 'manageCover | reviewAudit', note: 'controlled national ID and DOB correction with reason' },
    merge: { method: 'POST', path: '/patients/merge', permission: 'manageCover | reviewAudit', note: 'transactional practice-local survivor/source merge' },
  },

  appointments: {
    list: { method: 'GET', path: '/appointments', query: ['from', 'to', 'providerId', 'roomId'] },
    create: { method: 'POST', path: '/appointments', permission: 'scheduleVisit', note: '409 on provider or room interval overlap' },
    move: { method: 'PATCH', path: '/appointments/:id', permission: 'scheduleVisit', body: ['time', 'day', 'providerId', 'roomId'] },
    setStatus: { method: 'POST', path: '/appointments/:id/status', permission: 'checkIn', body: ['status', 'reason?'] },
    statusHistory: { method: 'GET', path: '/appointments/:id/status-history', permission: 'viewPatientDirectory' },
  },

  encounters: {
    list: { method: 'GET', path: '/patients/:id/encounters', permission: 'viewClinicalNotes' },
    createDraft: { method: 'POST', path: '/encounters', permission: 'writeNote' },
    saveDraft: { method: 'PUT', path: '/encounters/:id', permission: 'writeNote', note: '409 once signed — a signed note is immutable' },
    sign: { method: 'POST', path: '/encounters/:id/signature', permission: 'signNote', note: 'server stamps signer and time; rejects an incomplete SOAP body' },
    addendum: { method: 'POST', path: '/encounters/:id/addenda', permission: 'amendNote' },
  },

  documents: {
    list: { method: 'GET', path: '/patients/:id/documents', permission: 'viewClinicalNotes', note: 'metadata only; file bytes live in client-file storage' },
    upload: { method: 'POST', path: '/patients/:id/documents', permission: 'writeNote', note: 'PDF/images/DICOM, max 25 MB; stores metadata in DB and bytes externally' },
    archive: { method: 'POST', path: '/documents/:id/archive', permission: 'writeNote', note: 'soft archive; metadata is hidden from active lists, bytes remain stored' },
    download: { method: 'GET', path: '/documents/:id/download', permission: 'viewClinicalNotes', note: 'authorized stream from external client-file storage' },
  },
  patientExports: {
    request: { method: 'POST', path: '/patients/:id/exports', permission: 'exportPatientRecord' },
    list: { method: 'GET', path: '/patients/:id/exports', permission: 'exportPatientRecord' },
    status: { method: 'GET', path: '/patient-exports/:id', permission: 'exportPatientRecord' },
    download: { method: 'GET', path: '/patient-exports/:id/download', permission: 'exportPatientRecord', note: 'single-use private ZIP stream' },
    revoke: { method: 'POST', path: '/patient-exports/:id/revoke', permission: 'exportPatientRecord' },
  },

  billing: {
    listInvoices: { method: 'GET', path: '/invoices' },
    createInvoice: { method: 'POST', path: '/invoices', permission: 'createInvoice', note: 'creates a draft claim when the invoice has a scheme portion' },
    recordPayment: { method: 'POST', path: '/invoices/:id/payments', permission: 'recordPayment' },
    reversePayment: { method: 'POST', path: '/payments/:id/reversal', permission: 'recordPayment', note: 'counter-entry, never a deletion; reason of 10+ chars required' },
    adjustBalance: { method: 'POST', path: '/invoices/:id/adjustments', permission: 'adjustBalance', note: 'write-off or credit note — discharges the balance without a payment; reception deliberately cannot' },
    statement: { method: 'GET', path: '/patients/:id/statement', note: 'the whole account, oldest debt first — the order a tender is applied in' },
    aging: { method: 'GET', path: '/reports/aging', note: 'receivables bucketed current/1-30/31-60/61-90/90+' },
  },

  claims: {
    list: { method: 'GET', path: '/claims' },
    create: { method: 'POST', path: '/claims', permission: 'createClaims', note: 'creates a canonical claim from invoice/encounter data' },
    get: { method: 'GET', path: '/claims/:id' },
    update: { method: 'PATCH', path: '/claims/:id', permission: 'editClaims', note: 'draft/requires-action review fields only' },
    validate: { method: 'POST', path: '/claims/:id/validate', permission: 'readClaims', note: 'base and adapter-specific validation result' },
    submitCanonical: { method: 'POST', path: '/claims/:id/submit', permission: 'submitClaims', note: 'creates immutable snapshot and records a transmission' },
    refreshStatus: { method: 'POST', path: '/claims/:id/refresh-status', permission: 'refreshClaimStatus' },
    events: { method: 'GET', path: '/claims/:id/events', permission: 'readClaims' },
    transmissions: { method: 'GET', path: '/claims/:id/transmissions', permission: 'viewClaimTransmissions' },
    adjudication: { method: 'GET', path: '/claims/:id/adjudication', permission: 'readClaims' },
    attachDocument: { method: 'POST', path: '/claims/:id/attachments', permission: 'manageClaimAttachments' },
    configuration: { method: 'GET', path: '/claims/configuration', permission: 'readClaims' },
    captureBiometric: { method: 'POST', path: '/claims/:id/biometric', permission: 'captureBiometric', note: 'marks desk verification now; NH263 terminal proxy comes later' },
    submit: { method: 'POST', path: '/claims/:id/submission', permission: 'submitClaims', note: 'marks queued/submitted now; NH263 switch proxy comes later' },
    adjudicate: { method: 'POST', path: '/claims/:id/adjudication', permission: 'submitClaims', note: 'manual/internal outcome until NH263 responses are wired' },
  },

  messaging: {
    list: { method: 'GET', path: '/messages' },
    send: { method: 'POST', path: '/messages', permission: 'sendMessages', note: 'queues to the SMS/WhatsApp gateway' },
    cancel: { method: 'DELETE', path: '/messages/:id', permission: 'sendMessages', note: 'only while queued' },
  },

  ai: {
    askLuminary: { method: 'POST', path: '/ai/ask-luminary', permission: 'exportReports', body: ['question', 'conversationId?'] },
  },

  users: {
    list: { method: 'GET', path: '/users', permission: 'manageUsers' },
    invite: { method: 'POST', path: '/users/invitations', permission: 'manageUsers' },
    setRole: { method: 'PUT', path: '/users/:id/role', permission: 'assignRoles' },
    setActive: { method: 'PUT', path: '/users/:id/active', permission: 'manageUsers' },
    offboarding: { method: 'GET', path: '/users/:id/offboarding', permission: 'manageUsers' },
    reassignPatients: { method: 'POST', path: '/users/:id/reassign-patients', permission: 'manageUsers' },
    revokeSessions: { method: 'POST', path: '/users/:id/revoke-sessions', permission: 'manageUsers' },
    expiringRegistrations: { method: 'GET', path: '/users/registrations/expiring', permission: 'manageUsers' },
  },

  settings: {
    get: { method: 'GET', path: '/settings' },
    updatePractice: { method: 'PATCH', path: '/settings/practice', permission: 'manageConfiguration' },
    updateHours: { method: 'PATCH', path: '/settings/hours', permission: 'manageConfiguration' },
    updateScheme: { method: 'PUT', path: '/settings/schemes/:id', permission: 'manageConfiguration' },
    createRoom: { method: 'POST', path: '/settings/rooms', permission: 'manageConfiguration' },
    updateRoom: { method: 'PATCH', path: '/settings/rooms/:id', permission: 'manageConfiguration' },
    deleteRoom: { method: 'DELETE', path: '/settings/rooms/:id', permission: 'manageConfiguration' },
    upsertTariff: { method: 'POST', path: '/settings/tariffs', permission: 'manageConfiguration' },
    updateSecurity: { method: 'PATCH', path: '/settings/security', permission: 'manageConfiguration' },
    updateIntegrations: { method: 'PATCH', path: '/settings/integrations', permission: 'manageIntegrations' },
  },

  access: {
    listGrants: { method: 'GET', path: '/access-grants' },
    createGrant: { method: 'POST', path: '/access-grants', note: 'covering and referral grants; granted by a manager' },
    breakGlass: { method: 'POST', path: '/access-grants/break-glass', body: ['patientId', 'reason'], note: 'reason is mandatory; expires end of day; always audited at ALERT' },
  },

  audit: {
    list: { method: 'GET', path: '/audit', query: ['from', 'to', 'userId', 'severity'], permission: 'audit view', note: 'append-only; no update or delete endpoint exists by design' },
  },
};

/** Flattened for docs and for checking nothing has been forgotten. */
export function endpointList() {
  return Object.entries(ENDPOINTS).flatMap(([group, ops]) =>
    Object.entries(ops).map(([name, spec]) => ({ group, name, ...spec }))
  );
}
