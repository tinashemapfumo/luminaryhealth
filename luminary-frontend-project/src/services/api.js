/**
 * HTTP client for the Luminary API.
 *
 * `services/index.js` names the endpoints; this calls them. The split is
 * deliberate — that file stays readable as a contract, this one holds the
 * mechanics of talking to a server, and neither grows the other's concerns.
 *
 * ## Live-only build
 *
 * `VITE_API_URL` is required: no server means no workspace.
 * in memory. That is not a fallback for a failed request — a clinical system
 * that silently substitutes fabricated records when the network drops would be
 * dangerous. It is a separate mode, chosen up front, and the workspace says
 * which one it is running in. The standalone single-file build has no server by
 * Production builds fail if that URL is missing.
 *
 * ## The token
 *
 * Held in `sessionStorage`, not `localStorage`: a shared clinical workstation
 * should not hand the next person a live session because the last one closed
 * the tab instead of signing out. It is still a bearer token in a browser,
 * which is why the server keeps sessions revocable and idle-locks them.
 */

const BASE = (import.meta.env?.VITE_API_URL ?? '').replace(/\/+$/, '');

/** The workspace is live-only; this remains for callers that branch on mode. */
export const isLive = () => true;

const TOKEN_KEY = 'luminary:token';
let memoryToken = null;

/** sessionStorage throws in private mode and when site data is blocked. */
const safely = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const getToken = () => safely(() => window.sessionStorage.getItem(TOKEN_KEY), null) || memoryToken;
export const setToken = (token) => {
  memoryToken = token || null;
  safely(() =>
    token
      ? window.sessionStorage.setItem(TOKEN_KEY, token)
      : window.sessionStorage.removeItem(TOKEN_KEY),
  );
};

/**
 * A failed request, carrying what the caller needs to react rather than only a
 * message. `status` distinguishes "you may not" from "that does not exist";
 * `code` is the server's stable identifier, which is what break-glass keys on.
 */
export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.code = code ?? 'network_error';
    this.details = details ?? null;
  }

  /** The chart needs a reason before it may be opened. */
  get needsBreakGlass() {
    return this.status === 428 || this.code === 'break_glass_required';
  }

  get isUnauthenticated() {
    return this.status === 401;
  }
}

/** Listeners for a session that has ended server-side, so the shell can react. */
const expiryListeners = new Set();
export const onSessionExpired = (fn) => {
  expiryListeners.add(fn);
  return () => expiryListeners.delete(fn);
};

export async function request(method, path, { body, query, token } = {}) {
  if (!BASE) {
    throw new ApiError('Luminary API URL is not configured for this build.', {
      code: 'api_url_missing',
    });
  }

  const url = new URL(`${BASE}${path}`);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  const auth = token ?? getToken();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // The line drops several times a day in the deployment this is built for,
    // so an unreachable server is an expected state with its own message —
    // not an unexplained failure.
    throw new ApiError('Cannot reach the server. Check the connection and try again.', {
      code: 'unreachable',
      details: error.message,
    });
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    // A 401 only means "session expired" when this request actually presented
    // a session token. Public or pre-login checks can also receive 401, and
    // those should not make the shell flash a signed-out/session-expired state.
    if (response.status === 401 && auth) expiryListeners.forEach((fn) => fn());

    throw new ApiError(payload?.message ?? 'Something went wrong', {
      status: response.status,
      code: payload?.error,
      details: payload?.details,
    });
  }

  return payload;
}

const get = (path, query, options = {}) => request('GET', path, { query, ...options });
const post = (path, body) => request('POST', path, { body });
const patch = (path, body) => request('PATCH', path, { body });
const put = (path, body) => request('PUT', path, { body });
const del = (path) => request('DELETE', path);

/**
 * The callable form of `ENDPOINTS`.
 *
 * Grouped identically, so the contract and the client read side by side and a
 * missing implementation is visible as a gap rather than hidden in a helper.
 */
export const api = {
  practices: {
    list: () => get('/practices'),
  },

  auth: {
    /** The practice is named explicitly, so a wrong-tenant sign-in fails loudly. */
    signIn: (practiceId, email, password) =>
      post('/auth/session', { practiceId, email, password }),
    signOut: () => del('/auth/session'),
    unlock: (password) => post('/auth/unlock', { password }),
    me: (token) => get('/auth/me', undefined, token ? { token } : undefined),
  },

  patients: {
    list: (query) => get('/patients', query),
    get: (id, reason) => get(`/patients/${id}`, reason ? { reason } : undefined),
    create: (patient) => post('/patients', patient),
    update: (id, changes) => patch(`/patients/${id}`, changes),
    correctIdentity: (id, changes) => post(`/patients/${id}/identity-corrections`, changes),
    merge: (body) => post('/patients/merge', body),
  },

  appointments: {
    list: (query) => get('/appointments', query),
    create: (appointment) => post('/appointments', appointment),
    move: (id, changes) => patch(`/appointments/${id}`, changes),
    setStatus: (id, status, reason) => post(`/appointments/${id}/status`, { status, reason }),
    statusHistory: (id) => get(`/appointments/${id}/status-history`),
  },

  encounters: {
    list: (patientId) => get(`/patients/${patientId}/encounters`),
    createDraft: (encounter) => post('/encounters', encounter),
    saveDraft: (id, encounter) => put(`/encounters/${id}`, encounter),
    completeTriage: (id) => post(`/encounters/${id}/triage-complete`, {}),
    sign: (id) => post(`/encounters/${id}/signature`, {}),
    addendum: (id, body) => post(`/encounters/${id}/addenda`, body),
    createDictation: (id, body) => post(`/encounters/${id}/dictations`, body),
    createDictationFromAudio: (id, body) => post(`/encounters/${id}/dictations/audio`, body),
  },

  dictations: {
    get: (id) => get(`/dictations/${id}`),
    structure: (id) => post(`/dictations/${id}/structure`, {}),
    updateDraft: (id, draft) => patch(`/dictations/${id}/draft`, draft),
    approveNote: (id, fields) => post(`/dictations/${id}/approve-note`, fields),
    approvePrescription: (id, medication) => post(`/dictations/${id}/approve-prescription`, medication),
  },

  documents: {
    list: (patientId) => get(`/patients/${patientId}/documents`),
    upload: (patientId, document) => post(`/patients/${patientId}/documents`, document),
    archive: (id, reason) => post(`/documents/${id}/archive`, { reason }),
    downloadUrl: (id) => `${BASE}/documents/${id}/download`,
    download: async (id) => {
      const response = await fetch(`${BASE}/documents/${id}/download`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      }).catch((error) => {
        throw new ApiError('Cannot reach the server. Check the connection and try again.', {
          code: 'unreachable',
          details: error.message,
        });
      });
      if (!response.ok) {
        throw new ApiError('The document could not be downloaded', { status: response.status });
      }
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'document';
      return { filename, blob: await response.blob() };
    },
  },

  clinical: {
    summary: (patientId) => get(`/patients/${patientId}/clinical-summary`),
  },

  prescriptions: {
    create: (prescription) => post('/prescriptions', prescription),
  },

  patientExports: {
    request: (patientId, body) => post(`/patients/${patientId}/exports`, body),
    list: (patientId) => get(`/patients/${patientId}/exports`),
    status: (id) => get(`/patient-exports/${id}`),
    revoke: (id) => post(`/patient-exports/${id}/revoke`, {}),
    download: async (id) => {
      const response = await fetch(`${BASE}/patient-exports/${id}/download`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      }).catch((error) => {
        throw new ApiError('Cannot reach the server. Check the connection and try again.', {
          code: 'unreachable', details: error.message,
        });
      });
      if (!response.ok) throw new ApiError('The patient export could not be downloaded', { status: response.status });
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'patient-file.zip';
      return { filename, blob: await response.blob() };
    },
  },

  billing: {
    listInvoices: (query) => get('/invoices', query),
    getInvoice: (id) => get(`/invoices/${id}`),
    createInvoice: (invoice) => post('/invoices', invoice),
    recordPayment: (id, payment) => post(`/invoices/${id}/payments`, payment),
    reversePayment: (id, reason) => post(`/payments/${id}/reversal`, { reason }),
    adjustBalance: (id, adjustment) => post(`/invoices/${id}/adjustments`, adjustment),
    statement: (patientId) => get(`/patients/${patientId}/statement`),
    aging: () => get('/reports/aging'),
  },

  claims: {
    list: (query) => get('/claims', query),
    get: (id) => get(`/claims/${id}`),
    create: (claim) => post('/claims', claim),
    update: (id, changes) => patch(`/claims/${id}`, changes),
    validate: (id, body = {}) => post(`/claims/${id}/validate`, body),
    submitCanonical: (id, body = {}) => post(`/claims/${id}/submit`, body),
    refreshStatus: (id) => post(`/claims/${id}/refresh-status`, {}),
    events: (id) => get(`/claims/${id}/events`),
    transmissions: (id) => get(`/claims/${id}/transmissions`),
    adjudication: (id) => get(`/claims/${id}/adjudication`),
    remittances: (id) => get(`/claims/${id}/remittances`),
    createRemittance: (id, body) => post(`/claims/${id}/remittances`, body),
    getRemittance: (id, remittanceId) => get(`/claims/${id}/remittances/${remittanceId}`),
    recordDenialDisposition: (id, body) => post(`/claims/${id}/denial-dispositions`, body),
    attachDocument: (id, body) => post(`/claims/${id}/attachments`, body),
    configuration: () => get('/claims/configuration'),
    captureBiometric: (id, body = {}) => post(`/claims/${id}/biometric`, body),
    submit: (id, body = {}) => post(`/claims/${id}/submission`, body),
    adjudicate: (id, body) => post(`/claims/${id}/adjudication`, body),
  },

  catalogue: {
    services: (query) => get('/services', query),
    payers: () => get('/payers'),
    createPayer: (payer) => post('/payers', payer),
    createScheme: (scheme) => post('/schemes', scheme),
    tariffs: (query) => get('/tariffs', query),
    importBatches: () => get('/import-batches'),
    publishTariffs: (body) => post('/import-batches/tariffs', body),
    publishServices: (body) => post('/import-batches/services', body),
    addAlias: (serviceId, body) => post(`/services/${serviceId}/aliases`, body),
  },

  messaging: {
    list: (query) => get('/messages', query),
    send: (message) => post('/messages', message),
    cancel: (id) => del(`/messages/${id}`),
  },

  ai: {
    askLuminary: (body) => post('/ai/ask-luminary', body),
  },

  access: {
    listGrants: () => get('/access-grants'),
    createGrant: (grant) => post('/access-grants', grant),
    breakGlass: (patientId, reason) => post('/access-grants/break-glass', { patientId, reason }),
  },

  audit: {
    list: (query) => get('/audit', query),
    summary: (query) => get('/audit/summary', query),
  },

  users: {
    list: () => get('/users'),
    invite: (invitation) => post('/users/invitations', invitation),
    acceptInvitation: (acceptance) => post('/users/invitations/accept', acceptance),
    setRole: (id, role) => put(`/users/${id}/role`, { role }),
    setActive: (id, active) => put(`/users/${id}/active`, { active }),
    offboarding: (id) => get(`/users/${id}/offboarding`),
    reassignPatients: (id, toUserId) => post(`/users/${id}/reassign-patients`, { toUserId }),
    revokeSessions: (id) => post(`/users/${id}/revoke-sessions`, {}),
    expiringRegistrations: (withinDays = 60) => get('/users/registrations/expiring', { withinDays }),
  },

  settings: {
    get: () => get('/settings'),
    updatePractice: (changes) => patch('/settings/practice', changes),
    updateHours: (changes) => patch('/settings/hours', changes),
    updateScheme: (id, changes) => put(`/settings/schemes/${id}`, changes),
    createScheme: (scheme) => post('/settings/schemes', scheme),
    createRoom: (room) => post('/settings/rooms', room),
    updateRoom: (id, changes) => patch(`/settings/rooms/${id}`, changes),
    deleteRoom: (id) => del(`/settings/rooms/${id}`),
    upsertTariff: (tariff) => post('/settings/tariffs', tariff),
    updateSecurity: (changes) => patch('/settings/security', changes),
    updateIntegrations: (changes) => patch('/settings/integrations', changes),
  },

  sync: {
    status: () => get('/sync/status'),
    conflicts: () => get('/sync/conflicts'),
  },
};
