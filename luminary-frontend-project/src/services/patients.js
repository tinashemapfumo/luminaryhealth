import { useCallback, useEffect, useState } from 'react';
import { api, isLive, ApiError } from './api';

/**
 * The patient directory, live or seeded.
 *
 * This is the seam the workspace was built around. Every module — appointments,
 * billing, claims, clinical, communications — derives its rows from the patient
 * registry, so wiring this one collection to the API pulls the rest of the
 * application across with it. Nothing downstream of `patientRows` needs to know
 * which mode it is in.
 *
 * ## Shapes
 *
 * The server speaks snake_case columns; the interface speaks the vocabulary the
 * screens were designed around. Translating in one place keeps SQL naming out
 * of the components and, more importantly, keeps the two free to differ — the
 * registry row is a view assembled for one table, not a mirror of a database
 * row.
 *
 * ## What is deliberately not here
 *
 * No fallback to seed data when a request fails. A clinical system that
 * substitutes invented patients because the network dropped is worse than one
 * that says it cannot reach the server, so a failure surfaces as an error and
 * the directory stays empty.
 */

/** ISO timestamp → the short form the registry column expects. */
const shortDate = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

/** The next appointment reads as a time when it is today, a date otherwise. */
const nextVisitLabel = (iso) => {
  if (!iso) return 'Not scheduled';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Today ${time}` : `${shortDate(iso)} ${time}`;
};

export const formatBytes = (bytes) => {
  const size = Number(bytes ?? 0);
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
};

export function documentFromApi(doc) {
  return {
    id: doc.id,
    patientId: doc.patient_id,
    encounterId: doc.encounter_id,
    name: doc.filename,
    kind: doc.kind || 'Document',
    contentType: doc.content_type,
    added: shortDate(doc.created_at),
    size: formatBytes(doc.byte_size),
    checksum: doc.checksum,
    notes: doc.notes || '',
    uploadedBy: doc.uploaded_by_name || 'Unknown',
    live: true,
  };
}

/**
 * An API patient into a registry row.
 *
 * `practiceId` is filled from the session rather than the payload: the server
 * scopes every query to one tenant already, so a row that arrived at all
 * belongs to the caller's practice. Carrying the column would invite a client
 * filter that looks like a control and is not one.
 */
export function rowFromApi(patient, practiceId) {
  return {
    id: patient.reference || patient.id,
    patientId: patient.id,
    practiceId,
    name: patient.full_name,
    lastVisit: shortDate(patient.last_visit_at),
    next: nextVisitLabel(patient.next_visit_at),
    balance: Number(patient.balance ?? 0),
    status: patient.status || 'Active',
    providerId: patient.primary_provider_id || null,
    provider: patient.primary_provider_name || 'Unassigned',
    memberNo: patient.member_number || '',
    coverPlan: patient.scheme_name || 'Self-pay',
    allergies: patient.allergies ?? [],
    allergiesRecorded: patient.allergies_reviewed === true,
  };
}

/** The full chart, as the patient file renders it. */
export function recordFromApi(patient) {
  return {
    id: patient.reference || patient.id,
    patientId: patient.id,
    name: patient.full_name,
    preferredName: patient.preferred_name || '',
    dob: patient.date_of_birth || '',
    sex: patient.sex || '',
    nationalId: patient.national_id || '',
    maritalStatus: patient.marital_status || '',
    occupation: patient.occupation || '',
    language: patient.language || '',
    phone: patient.phone || '',
    altPhone: patient.alt_phone || '',
    email: patient.email || '',
    addressStreet: patient.address_street || '',
    addressSuburb: patient.address_suburb || '',
    addressCity: patient.address_city || '',
    addressCountry: patient.address_country || 'Zimbabwe',
    preferredContact: patient.preferred_contact || '',
    emergencyName: patient.emergency_name || '',
    emergencyRelationship: patient.emergency_relation || '',
    emergencyPhone: patient.emergency_phone || '',
    schemeId: patient.scheme_id || null,
    coverPlan: patient.scheme_name || 'Self-pay',
    memberNo: patient.member_number || '',
    principalMember: patient.principal_member || '',
    dependantCode: patient.dependant_code || '',
    coverEffectiveFrom: patient.cover_effective_from || '',
    coverValidUntil: patient.cover_valid_until || '',
    coverStatus: patient.cover_status || '',
    bloodType: patient.blood_type || '',
    allergiesRecorded: patient.allergies_reviewed === true,
    allergies: patient.allergies ?? [],
    conditions: patient.conditions ?? [],
    medications: patient.medications ?? [],
    familyHistory: patient.family_history ?? [],
    smoking: patient.smoking || '',
    alcohol: patient.alcohol || '',
    exercise: patient.exercise || '',
    immunisations: patient.immunisations ?? [],
    risk: patient.risk || '',
    registered: patient.registered_on || '',
    consentTreatment: patient.consent_treatment === true,
    consentComms: patient.consent_comms === true,
    consentDataSharing: patient.consent_data_sharing === true,
    // Owned by other endpoints. Empty rather than absent, so the file renders
    // its empty states instead of throwing on a missing array.
    notes: [],
    timeline: [],
    documents: (patient.documents ?? []).map(documentFromApi),
  };
}

/** The registration form into the create body the server validates. */
export function createBodyFromForm(form, { reference, duplicateAcknowledged = false } = {}) {
  return {
    reference,
    fullName: form.name?.trim(),
    dateOfBirth: form.dob,
    sex: form.sex,
    nationalId: form.nationalId?.trim() || null,
    phone: form.phone?.trim(),
    email: form.email?.trim() || undefined,
    addressCity: form.addressCity?.trim() || form.city?.trim(),
    emergencyName: form.emergencyName?.trim(),
    emergencyRelation: form.emergencyRelationship,
    emergencyPhone: form.emergencyPhone?.trim(),
    schemeId: form.schemeId || undefined,
    memberNumber: form.memberNo?.trim() || undefined,
    principalMember: form.principalMember?.trim() || undefined,
    dependantCode: form.dependantCode?.trim() || undefined,
    coverEffectiveFrom: form.coverEffectiveFrom || undefined,
    coverValidUntil: form.coverValidUntil || undefined,
    coverStatus: form.coverStatus || undefined,
    consentTreatment: form.consentTreatment === true,
    consentComms: form.consentComms === true,
    duplicateAcknowledged,
  };
}

/**
 * A chart edit into a patch body.
 *
 * Only the keys the form actually changed are sent. The server permissions
 * updates field group by field group — a clinician may edit allergies without
 * being able to touch medical aid cover — so sending the whole record back
 * would be refused for the groups the caller cannot write, even where they
 * changed nothing in them.
 */
const PATCHABLE = {
  name: 'fullName',
  preferredName: 'preferredName',
  dob: 'dateOfBirth',
  sex: 'sex',
  nationalId: 'nationalId',
  maritalStatus: 'maritalStatus',
  occupation: 'occupation',
  language: 'language',
  phone: 'phone',
  altPhone: 'altPhone',
  email: 'email',
  addressStreet: 'addressStreet',
  addressSuburb: 'addressSuburb',
  addressCity: 'addressCity',
  addressCountry: 'addressCountry',
  preferredContact: 'preferredContact',
  emergencyName: 'emergencyName',
  emergencyRelationship: 'emergencyRelation',
  emergencyPhone: 'emergencyPhone',
  coverPlan: 'coverPlan',
  schemeId: 'schemeId',
  memberNo: 'memberNumber',
  principalMember: 'principalMember',
  dependantCode: 'dependantCode',
  coverEffectiveFrom: 'coverEffectiveFrom',
  coverValidUntil: 'coverValidUntil',
  coverStatus: 'coverStatus',
  bloodType: 'bloodType',
  allergies: 'allergies',
  allergiesRecorded: 'allergiesReviewed',
  conditions: 'conditions',
  medications: 'medications',
  familyHistory: 'familyHistory',
  immunisations: 'immunisations',
  smoking: 'smoking',
  alcohol: 'alcohol',
  exercise: 'exercise',
  risk: 'risk',
  consentComms: 'consentComms',
  consentDataSharing: 'consentDataSharing',
};

export function patchFromChanges(before, after) {
  const patch = {};
  for (const [local, remote] of Object.entries(PATCHABLE)) {
    const from = before?.[local];
    const to = after?.[local];
    if (JSON.stringify(from) !== JSON.stringify(to)) patch[remote] = to;
  }
  return patch;
}

/**
 * Owns the directory in live mode and stays out of the way in demo mode.
 *
 * Returns the same shape either way, so the shell holds one pair of collections
 * rather than branching on mode everywhere it reads them.
 */
export function usePatientDirectory({ practiceId, seedRows, seedRecords, scope, search, onError }) {
  const live = isLive();
  const [rows, setRows] = useState(live ? [] : seedRows);
  const [records, setRecords] = useState(live ? {} : seedRecords);
  const [loading, setLoading] = useState(live);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!live) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await api.patients.list({ scope, search });
      setRows(payload.map((p) => rowFromApi(p, practiceId)));
    } catch (err) {
      setError(err);
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  }, [live, scope, search, practiceId, onError]);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * Open a chart.
   *
   * The 428 is the interesting case: the server refuses, names the patient, and
   * waits for a reason. That is not an error to be reported — it is the
   * break-glass flow, so it is returned as a state the caller can act on rather
   * than thrown.
   */
  const open = useCallback(
    async (patient, reason) => {
      if (!live) return { ok: true, record: records[patient.id] };
      try {
        const payload = await api.patients.get(patient.patientId ?? patient.id, reason);
        const record = recordFromApi(payload.patient);
        setRecords((prev) => ({ ...prev, [record.id]: record }));
        return { ok: true, record, breakGlass: payload.breakGlass, relationship: payload.relationship };
      } catch (err) {
        if (err instanceof ApiError && err.needsBreakGlass) {
          return { ok: false, needsBreakGlass: true, message: err.message };
        }
        return { ok: false, message: err.message };
      }
    },
    [live, records],
  );

  return { live, rows, setRows, records, setRecords, loading, error, reload, open };
}
