import { useCallback, useEffect, useState } from 'react';
import { api, isLive } from './api';

const titleCase = (value) =>
  String(value || '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const shortDate = (value) => {
  if (!value) return 'Not recorded';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

const timeLabel = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

const dayOffset = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - start) / 86400000);
};

const statusTone = (status) => {
  const normal = String(status || '').toLowerCase();
  if (['paid', 'remitted', 'adjudicated', 'delivered', 'completed', 'sent'].includes(normal)) return 'success';
  if (['overdue', 'rejected', 'failed', 'cancelled', 'no_show'].includes(normal)) return 'alert';
  if (['pending', 'part_paid', 'submitted', 'queued', 'sending', 'checked_in', 'in_triage', 'waiting_for_provider', 'in_consultation'].includes(normal)) return 'warm';
  return 'neutral';
};

const visitStatusLabel = (status) => ({
  booked: 'Booked',
  checked_in: 'Checked in',
  in_triage: 'In triage',
  waiting_for_provider: 'Ready for provider',
  in_consultation: 'In consultation',
  completed: 'Completed',
  no_show: 'No-show',
  cancelled: 'Cancelled',
}[String(status || '').toLowerCase()] || titleCase(status || 'booked'));

const claimStatusLabel = (status) => ({
  draft: 'Draft',
  biometric_verified: 'Biometric verified',
  ready: 'Ready',
  validation_failed: 'Validation failed',
  ready_for_submission: 'Ready for submission',
  submitting: 'Submitting',
  acknowledged: 'Acknowledged',
  processing: 'Processing',
  approved: 'Approved',
  partially_approved: 'Partially approved',
  query: 'Query',
  requires_action: 'Requires action',
  cancelled: 'Cancelled',
  failed: 'Failed',
  submitted: 'Submitted',
  adjudicated: 'Approved',
  remitted: 'Approved',
  rejected: 'Rejected',
}[String(status || '').toLowerCase()] || titleCase(status || 'draft'));

export const appointmentFromApi = (row) => ({
  id: row.id,
  patientId: row.patient_id,
  patient: row.patient_name,
  origin: row.origin || 'scheduled',
  arrivedAt: row.arrived_at,
  day: dayOffset(row.starts_at || row.arrived_at),
  duration: Number(row.duration_min ?? 30),
  time: timeLabel(row.starts_at || row.arrived_at),
  scheduledTime: timeLabel(row.starts_at),
  arrivalTime: timeLabel(row.arrived_at),
  type: row.visit_type || 'Visit',
  providerId: row.provider_id,
  provider: row.provider_name || 'Unassigned',
  room: row.room_name || 'Unassigned',
  mode: row.mode === 'telehealth' ? 'Telehealth' : 'In person',
  status: visitStatusLabel(row.status),
});

const paymentFromApi = (row) => ({
  id: row.id,
  amount: Number(row.amount ?? 0),
  currency: row.currency,
  fxRate: Number(row.fx_rate ?? 1),
  method: row.method,
  responsibilityBucket: row.responsibility_bucket || 'patient',
  claimId: row.claim_id,
  claimNumber: row.claim_number,
  remittanceId: row.remittance_id,
  remittanceReference: row.remittance_reference,
  payerId: row.payer_id,
  payerName: row.payer_name,
  paymentReference: row.payment_reference,
  receivedAt: row.received_at,
  receivedBy: row.received_by || 'Unknown',
  reversesId: row.reverses_id,
});

const adjustmentFromApi = (row) => ({
  id: row.id,
  type: row.kind,
  amount: Number(row.amount ?? 0),
  currency: row.currency,
  reason: row.reason,
  responsibilityBucket: row.responsibility_bucket || 'patient',
  claimId: row.claim_id,
  claimLineId: row.claim_line_id,
  at: row.decided_at,
  by: row.decided_by_name || 'Unknown',
});

const lineFromApi = (row) => ({
  id: row.id,
  origin: row.origin || 'manual',
  serviceId: row.service_id,
  serviceName: row.service_name,
  orderId: row.order_id,
  encounterId: row.encounter_id,
  appointmentId: row.appointment_id,
  tariffId: row.tariff_id,
  tariffVia: row.tariff_via,
  billingKey: row.billing_key,
  code: row.tariff_code,
  desc: row.description,
  quantity: Number(row.quantity ?? 1),
  unitPrice: Number(row.unit_price ?? 0),
  amount: Number(row.unit_price ?? 0) * Number(row.quantity ?? 1),
  gross: Number(row.unit_price ?? 0) * Number(row.quantity ?? 1),
  insurance: Number(row.scheme_pays ?? 0),
  estimatedFunder: Number(row.scheme_pays ?? 0),
  estimatedPatient: Math.max(0, Number(row.unit_price ?? 0) * Number(row.quantity ?? 1) - Number(row.scheme_pays ?? 0)),
  actualFunderApproved: null,
  actualFunderPaid: null,
});

export const invoiceFromApi = (row) => ({
  id: row.reference || row.id,
  apiId: row.id,
  patientId: row.patient_id,
  patient: row.patient_name,
  schemeId: row.scheme_id || null,
  payerId: row.payer_id || null,
  payerName: row.payer_name || '',
  memberNo: row.member_number || '',
  date: shortDate(row.issued_on),
  issuedOn: row.issued_on,
  dueDate: shortDate(row.due_on),
  dueOn: row.due_on,
  amount: Number(row.total ?? 0),
  currency: row.currency,
  status: titleCase(row.status || 'pending'),
  tone: statusTone(row.status),
  claim: row.claim_reference || '',
  claimApiId: row.claim_id || null,
  claimStatus: titleCase(row.claim_status || 'Not created'),
  services: (row.lines ?? []).map(lineFromApi),
  patientResponsibility: Number(row.patient_portion ?? row.outstanding ?? 0),
  estimatedPatientResponsibility: Number(row.estimated_patient_responsibility ?? row.patient_portion ?? 0),
  estimatedInsurerResponsibility: Number(row.estimated_insurer_responsibility ?? row.scheme_portion ?? 0),
  insurerResponsibility: Number(row.insurer_responsibility ?? row.scheme_portion ?? 0),
  insurerPaid: Number(row.insurer_paid ?? 0),
  insurerOutstanding: Number(row.insurer_outstanding ?? 0),
  patientPaid: Number(row.patient_paid ?? row.amount_paid ?? 0),
  patientOutstanding: Number(row.patient_outstanding ?? row.outstanding ?? 0),
  unresolvedDeniedAmount: Number(row.unresolved_denied_amount ?? 0),
  totalPracticeOutstanding: Number(row.total_practice_outstanding ?? row.outstanding ?? 0),
  receivables: row.receivables ?? null,
  insurance: row.scheme_name || 'Self-pay',
  payments: (row.payments ?? []).map(paymentFromApi),
  adjustments: (row.adjustments ?? []).map(adjustmentFromApi),
});

export const claimFromApi = (row) => ({
  id: row.claim_number || row.reference || row.id,
  apiId: row.id,
  patientId: row.patient_id,
  patient: row.patient_name,
  memberNo: row.membership_number || row.member_number || '',
  plan: row.scheme_name || 'Self-pay',
  provider: row.provider_name || 'Provider not recorded',
  serviceDate: shortDate(row.service_from_date || row.created_at),
  amount: `${row.currency || ''} ${Number(row.total_claimed_amount ?? row.total ?? 0).toFixed(2)}`.trim(),
  invoice: row.invoice_reference || row.invoice_id,
  encounterId: row.encounter_id || '',
  tariff: row.tariff || (row.lines?.[0]?.tariff_code ? `${row.lines[0].tariff_code} · ${row.lines[0].tariff_description}` : 'Claim lines on invoice'),
  icd10: row.icd10 || (row.diagnoses?.length ? row.diagnoses.map((d) => `${d.code}${d.description ? `, ${d.description}` : ''}`).join('; ') : 'Not coded'),
  status: claimStatusLabel(row.status),
  rejectionCode: row.rejection_code,
  submissionChannel: row.submission_channel || 'MANUAL',
  externalReference: row.external_reference || row.switch_reference || '',
  claimed: Number(row.total_claimed_amount ?? row.total ?? 0),
  currency: row.currency || 'USD',
  approved: Number(row.total_approved_amount ?? 0),
  insurerLiability: Number(row.insurer_liability ?? 0),
  memberLiability: Number(row.member_liability ?? 0),
  serviceFromDate: row.service_from_date || '',
  serviceToDate: row.service_to_date || '',
  notes: row.notes || '',
  lines: row.lines ?? [],
  diagnoses: row.diagnoses ?? [],
  attachments: row.attachments ?? [],
  validation: row.validation_result ?? { valid: false, errors: [], warnings: [] },
  emailSubmission: row.email_draft ?? {},
  biometric: row.biometric_at ? `Captured ${shortDate(row.biometric_at)} ${timeLabel(row.biometric_at)}` : 'Not captured',
  eligibility: row.scheme_name ? 'Cover on file' : 'Self-pay',
  responses: Array.isArray(row.responses) ? row.responses : [],
});

export const messageFromApi = (row) => ({
  id: row.id,
  patientId: row.patient_id,
  patient: row.patient_name || row.recipient,
  channel: titleCase(row.channel),
  type: titleCase(row.template || 'manual'),
  message: row.body,
  time: timeLabel(row.delivered_at || row.sent_at || row.queued_at),
  status: titleCase(row.status),
  tone: statusTone(row.status),
});

const addendaFromApi = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    text: entry.body || entry.text || '',
    by: entry.author_name || entry.by || 'Unknown',
    at: entry.created_at ? `${shortDate(entry.created_at)} ${timeLabel(entry.created_at)}` : entry.at || '',
  }));
};

export const encounterFromApi = (row, patient) => ({
  id: row.id,
  patientId: patient?.id || row.patient_reference || row.patient_id,
  patientApiId: row.patient_id,
  patientName: patient?.name || row.patient_name,
  provider: row.signed_by_name || row.created_by_name || row.author_name || row.provider_name || 'Provider not recorded',
  createdBy: row.created_by_name || row.author_name || '',
  contributors: Array.isArray(row.contributors) ? row.contributors : [],
  triageCompletedAt: row.triage_completed_at ? `${shortDate(row.triage_completed_at)} ${timeLabel(row.triage_completed_at)}` : '',
  triageCompletedBy: row.triage_completed_by_name || '',
  appointmentTime: row.appointment_time || 'Unscheduled',
  date: shortDate(row.created_at),
  type: row.note_type || 'SOAP note',
  status: titleCase(row.status || 'draft'),
  vitals: row.vitals || {},
  vitalsRecordedBy: row.vitals_by_name || '',
  subjective: row.subjective || '',
  objective: row.objective || '',
  assessment: row.assessment || '',
  plan: row.plan || '',
  diagnoses: Array.isArray(row.diagnoses) ? row.diagnoses : [],
  followUp: row.follow_up || '',
  signedBy: row.signed_by_name || '',
  signedAt: row.signed_at ? `${shortDate(row.signed_at)} ${timeLabel(row.signed_at)}` : '',
  addenda: addendaFromApi(row.addenda),
  addendumCount: Number(row.addendum_count ?? (Array.isArray(row.addenda) ? row.addenda.length : row.addenda) ?? 0),
});

export const prescriptionFromApi = (row, fallbackPrescriberName) => ({
  id: row.id,
  // Medicines issued together share a group: that group is the prescription.
  groupId: row.issue_group_id || row.id,
  patientId: row.patient_id,
  encounterId: row.encounter_id,
  drug: row.drug,
  form: row.form || '',
  strength: row.strength || '',
  dose: row.dose || '',
  route: row.route || '',
  frequency: row.frequency || '',
  directions: row.frequency || '',
  duration: row.duration_days ? `${row.duration_days} day${Number(row.duration_days) === 1 ? '' : 's'}` : '',
  durationDays: row.duration_days ?? null,
  quantity: row.quantity ?? null,
  refills: row.refills ?? 0,
  indication: row.indication || '',
  pharmacy: row.pharmacy || '',
  substitutionAllowed: row.substitution_allowed ?? null,
  notes: row.instructions || '',
  status: titleCase(row.status || 'active'),
  tone: statusTone(row.status),
  prescriber: row.prescriber_name || fallbackPrescriberName || '',
  prescriberRegistration: row.prescriber_registration || '',
  issuedAt: row.issued_at
    ? `${shortDate(row.issued_at)} ${timeLabel(row.issued_at)}`
    : row.created_at ? `${shortDate(row.created_at)} ${timeLabel(row.created_at)}` : '',
});

export const labResultFromApi = (row) => ({
  id: row.id,
  patientId: row.patient_id,
  test: row.test_name,
  value: row.value || 'Not recorded',
  unit: row.unit || '',
  normal: row.normal_range || 'Not recorded',
  date: shortDate(row.resulted_on),
  status: row.reviewed_at ? 'Reviewed' : row.abnormal ? 'Requires review' : 'Resulted',
  tone: row.abnormal ? 'alert' : row.reviewed_at ? 'success' : 'neutral',
});

const carePlanItems = (items) => (Array.isArray(items)
  ? items.map((item) => (typeof item === 'string' ? item : item?.text)).filter(Boolean)
  : []);

export const carePlanFromApi = (row) => ({
  id: row.id,
  patientId: row.patient_id,
  name: row.name,
  status: titleCase(row.status || 'active'),
  progress: `${Number(row.progress) || 0}%`,
  goals: carePlanItems(row.goals),
  interventions: carePlanItems(row.interventions),
  startDate: shortDate(row.created_at),
  nextReview: shortDate(row.next_review),
  tone: statusTone(row.status),
});

/**
 * Fold medicine rows into prescriptions: one entry per issue, carrying its
 * medicines as `items`, in the order the (newest-first) list presents them.
 * Status is the shared status when every medicine agrees, otherwise the
 * prescription is shown as partly active so no single-medicine change hides.
 */
export const groupPrescriptions = (rows = []) => {
  const groups = new Map();
  for (const rx of rows) {
    const key = rx.groupId || rx.id;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        groupId: key,
        patientId: rx.patientId,
        encounterId: rx.encounterId,
        issuedAt: rx.issuedAt,
        prescriber: rx.prescriber,
        prescriberRegistration: rx.prescriberRegistration,
        pharmacy: rx.pharmacy,
        items: [],
      });
    }
    const group = groups.get(key);
    group.items.push(rx);
    if (!group.pharmacy && rx.pharmacy) group.pharmacy = rx.pharmacy;
  }
  return [...groups.values()].map((group) => {
    const statuses = [...new Set(group.items.map((item) => item.status))];
    const uniform = statuses.length === 1;
    return {
      ...group,
      status: uniform ? statuses[0] : 'Partly active',
      tone: uniform ? group.items[0].tone : 'warm',
      mixedStatus: !uniform,
    };
  });
};

export const auditFromApi = (row) => ({
  id: row.id,
  user: row.actor_name || row.actor_id || 'System',
  action: row.action,
  subject: row.subject_label || row.subject_id || row.subject_type || '',
  detail: row.detail || '',
  severity: row.severity,
  at: row.created_at,
});

const asTime = (value, fallback = '') => String(value || fallback).slice(0, 5);

export const settingsFromApi = (payload, fallback = {}) => {
  const profile = payload.practice || {};
  const hours = payload.hours || {};
  const security = payload.security || {};
  const integrations = payload.integrations || {};

  return {
    profile: {
      ...(fallback.profile || {}),
      name: profile.name || fallback.profile?.name || '',
      short: profile.short_name || fallback.profile?.short || '',
      addressLine: profile.address_line || '',
      city: profile.city || fallback.profile?.city || '',
      phone: profile.phone || '',
      email: profile.email || '',
      primaryCurrency: profile.primary_currency || fallback.profile?.primaryCurrency || 'USD',
      secondaryCurrency: profile.secondary_currency || '',
      usdRate: profile.usd_rate ?? '',
    },
    providers: (payload.providers || []).map((provider) => ({
      id: provider.id,
      name: provider.display_name,
      speciality: provider.job_title || 'Clinician',
      registration: provider.registration_number || '',
      registrationExpires: provider.registration_expires || '',
      active: provider.active !== false,
    })),
    rooms: (payload.rooms || []).map((room) => ({
      id: room.id,
      name: room.name,
      kind: room.kind,
      active: room.active !== false,
    })),
    hours: {
      ...(fallback.hours || {}),
      opensAt: asTime(hours.opensAt, fallback.hours?.opensAt),
      closesAt: asTime(hours.closesAt, fallback.hours?.closesAt),
      slotMinutes: String(hours.slotMinutes ?? fallback.hours?.slotMinutes ?? 15),
      openDays: hours.openDays || fallback.hours?.openDays || [],
    },
    schemes: (payload.schemes || []).map((scheme) => ({
      id: scheme.id,
      payerId: scheme.payer_id || null,
      name: scheme.name,
      rate: Number(scheme.reimburse_percent ?? 0),
      requiresPreAuth: !!scheme.requires_preauth,
      active: scheme.active !== false,
    })),
    services: (payload.tariffs || []).map((tariff) => ({
      code: tariff.code,
      description: tariff.description,
      price: Number(tariff.price ?? 0),
      active: tariff.active !== false,
      currency: tariff.currency,
    })),
    integrations: {
      nh263ProviderNumber: integrations.nh263ProviderNumber || '',
      nh263Endpoint: integrations.nh263Endpoint || '',
      nh263Connected: Boolean(integrations.nh263ProviderNumber && integrations.nh263Endpoint),
      smsSender: integrations.smsSenderId || '',
      smsGateway: integrations.smsGateway || '',
      smsConnected: Boolean(integrations.smsSenderId && integrations.smsGateway),
    },
    security: {
      ...(fallback.security || {}),
      idleTimeoutMinutes: String(security.idleTimeoutMinutes ?? fallback.security?.idleTimeoutMinutes ?? 15),
      minimumPasswordLength: security.minimumPasswordLength ?? fallback.security?.minimumPasswordLength ?? 12,
      breakGlassEnabled: security.breakGlassEnabled ?? fallback.security?.breakGlassEnabled ?? true,
      enforceRegistrationExpiry: security.enforceRegistration ?? fallback.security?.enforceRegistrationExpiry ?? true,
    },
  };
};

/**
 * Remaining live module reads.
 *
 * Demo mode keeps the seeded/persisted collections. Live mode starts empty and
 * only shows rows returned by the API, so real patients are never displayed
 * beside invented appointments, invoices, claims, messages, or audit entries.
 */
export function useLiveWorkspaceData({ enabled = isLive(), onError } = {}) {
  const [appointments, setAppointments] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [claims, setClaims] = useState([]);
  const [messages, setMessages] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    const load = async (work, setter, mapper) => {
      try {
        const rows = await work();
        setter(rows.map(mapper));
      } catch (error) {
        setter([]);
        if (error.status !== 403) onError?.(error.message);
      }
    };
    const loadOne = async (work, setter, mapper) => {
      try {
        const row = await work();
        setter(mapper(row));
      } catch (error) {
        setter(null);
        if (error.status !== 403) onError?.(error.message);
      }
    };

    try {
      await Promise.all([
        loadOne(() => api.settings.get(), setSettings, (row) => row),
        load(() => api.appointments.list(), setAppointments, appointmentFromApi),
        load(() => api.billing.listInvoices(), setInvoices, invoiceFromApi),
        load(() => api.claims.list(), setClaims, claimFromApi),
        load(() => api.messaging.list(), setMessages, messageFromApi),
        load(() => api.audit.list(), setAuditLog, auditFromApi),
      ]);
    } finally {
      setLoading(false);
    }
  }, [enabled, onError]);

  useEffect(() => {
    reload();
  }, [reload]);

  return {
    loading,
    reload,
    appointments,
    setAppointments,
    invoices,
    setInvoices,
    claims,
    setClaims,
    messages,
    setMessages,
    auditLog,
    setAuditLog,
    settings,
    setSettings,
  };
}
