/**
 * Per-practice configuration.
 *
 * Everything here was a hardcoded constant until now — providers, rooms, clinic
 * hours, cover schemes, the insurance split. That mattered because these are
 * the difference between a constant and a database table: decide them after the
 * backend exists and you are retrofitting `providers` and `services` tables
 * into a live system with foreign keys already pointing at strings.
 *
 * Treat this shape as the schema proposal. Each top-level key becomes a table
 * or a column group scoped by `practice_id`.
 */

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Re-exported from the money rules rather than restated. Two lists that must
// agree and are written down twice will eventually not agree.
export { CURRENCIES } from '../lib/money.js';
export const SLOT_LENGTHS = ['10', '15', '20', '30'];
export const IDLE_TIMEOUTS = ['5', '10', '15', '30', '60'];

/** Seed configuration for each practice. */
export const defaultSettings = {
  'PRC-001': {
    profile: {
      name: 'Harare Central Clinic',
      short: 'Harare Central',
      addressLine: '18 Josiah Tongogara Avenue, Avondale',
      city: 'Harare',
      phone: '+263 24 270 1100',
      email: 'reception@hararecentral.co.zw',
      // Zimbabwe is heavily dollarised: practices quote in USD and collect in
      // either, on the same day. `usdRate` stays "1 USD = n ZWL" whichever way
      // round the pair is configured, so the rate means one thing everywhere.
      primaryCurrency: 'USD',
      secondaryCurrency: 'ZWL',
      usdRate: 32.5,
    },
    providers: [
      { id: 'USR-001', name: 'Dr. Chen', speciality: 'General Practice', registration: 'HPCZ-GP-4471', registrationExpires: '2027-03-31', active: true },
      { id: 'USR-002', name: 'Dr. Ahmed', speciality: 'General Practice', registration: 'HPCZ-GP-3902', registrationExpires: '2026-11-30', active: true },
      { id: 'USR-003', name: 'Dr. Park', speciality: 'Cardiology', registration: 'HPCZ-SP-1180', registrationExpires: '2027-06-30', active: true },
      { id: 'USR-004', name: 'Dr. Singh', speciality: 'General Practice', registration: 'HPCZ-GP-5514', registrationExpires: '2026-09-15', active: true },
    ],
    rooms: [
      { id: 'R1', name: 'Room 1', kind: 'Consulting', active: true },
      { id: 'R2', name: 'Room 2', kind: 'Consulting', active: true },
      { id: 'R3', name: 'Room 3', kind: 'Consulting', active: true },
      { id: 'R4', name: 'Room 4', kind: 'Procedure', active: true },
    ],
    hours: {
      opensAt: '08:00',
      closesAt: '17:00',
      slotMinutes: '15',
      openDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    },
    // Reimbursement is per scheme, not a flat 80% — this replaces a hardcoded
    // `amount * 0.8` that was computing real money from a guess.
    schemes: [
      { id: 'SCH-A', name: 'NH263 Plan A', rate: 90, requiresPreAuth: false, active: true },
      { id: 'SCH-B', name: 'NH263 Plan B', rate: 80, requiresPreAuth: true, active: true },
      { id: 'SCH-C', name: 'NH263 Plan C', rate: 80, requiresPreAuth: false, active: true },
      { id: 'SCH-SELF', name: 'Self-pay', rate: 0, requiresPreAuth: false, active: true },
    ],
    services: [
      { code: '99213', description: 'Office visit, established patient', price: 40, active: true },
      { code: '99203', description: 'New patient consultation', price: 45, active: true },
      { code: '99214', description: 'Extended review', price: 75, active: true },
      { code: '93000', description: 'ECG, routine', price: 20, active: true },
      { code: '80053', description: 'Metabolic panel', price: 40, active: true },
      { code: '99212', description: 'Medication review', price: 25, active: true },
    ],
    integrations: {
      nh263ProviderNumber: 'PRV-HRE-004821',
      nh263Endpoint: 'https://switch.nh263.co.zw/v2',
      nh263Connected: true,
      smsSender: 'HRE-CENTRAL',
      smsGateway: 'Twilio',
      smsConnected: true,
      whatsappConnected: true,
    },
    security: {
      idleTimeoutMinutes: '15',
      breakGlassEnabled: true,
      breakGlassRequiresReason: true,
      minimumPasswordLength: 12,
      enforceRegistrationExpiry: true,
    },
  },

  'PRC-002': {
    profile: {
      name: 'Bulawayo Family Practice',
      short: 'Bulawayo Family',
      addressLine: '7 Banff Road, Hillside',
      city: 'Bulawayo',
      phone: '+263 29 288 4410',
      email: 'reception@bulawayofamily.co.zw',
      primaryCurrency: 'USD',
      secondaryCurrency: 'ZWL',
      usdRate: 32.5,
    },
    providers: [
      { id: 'USR-101', name: 'Dr. Ncube', speciality: 'Family Medicine', registration: 'HPCZ-GP-7731', registrationExpires: '2027-01-31', active: true },
    ],
    rooms: [
      { id: 'R1', name: 'Consulting room', kind: 'Consulting', active: true },
      { id: 'R2', name: 'Treatment room', kind: 'Procedure', active: true },
    ],
    hours: {
      opensAt: '08:30',
      closesAt: '16:00',
      slotMinutes: '20',
      openDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    },
    schemes: [
      { id: 'SCH-A', name: 'NH263 Plan A', rate: 90, requiresPreAuth: false, active: true },
      { id: 'SCH-SELF', name: 'Self-pay', rate: 0, requiresPreAuth: false, active: true },
    ],
    services: [
      { code: '99213', description: 'Office visit, established patient', price: 25, active: true },
      { code: '99203', description: 'New patient consultation', price: 40, active: true },
    ],
    integrations: {
      nh263ProviderNumber: 'PRV-BYO-020114',
      nh263Endpoint: 'https://switch.nh263.co.zw/v2',
      nh263Connected: true,
      smsSender: 'BYO-FAMILY',
      smsGateway: 'Twilio',
      smsConnected: false,
      whatsappConnected: false,
    },
    security: {
      idleTimeoutMinutes: '10',
      breakGlassEnabled: true,
      breakGlassRequiresReason: true,
      minimumPasswordLength: 10,
      enforceRegistrationExpiry: true,
    },
  },
};

/** Reimbursement rate for a named scheme, falling back to self-pay. */
export function schemeRate(settings, schemeName) {
  const scheme = settings?.schemes?.find((s) => s.name === schemeName);
  return scheme ? scheme.rate / 100 : 0;
}

/** Registrations lapsing within 60 days — a clinician whose registration
 *  expires must not be able to sign notes or prescribe. */
export function expiringRegistrations(settings, withinDays = 60) {
  const limit = new Date();
  limit.setDate(limit.getDate() + withinDays);
  return (settings?.providers || []).filter((p) => {
    if (!p.active || !p.registrationExpires) return false;
    const expires = new Date(p.registrationExpires);
    return expires <= limit;
  });
}

export const activeProviderNames = (settings) =>
  (settings?.providers || []).filter((p) => p.active).map((p) => p.name);

export const activeRoomNames = (settings) =>
  (settings?.rooms || []).filter((r) => r.active).map((r) => r.name);

/** Billable services the practice has actually configured and left switched on. */
export const activeServices = (settings) =>
  (settings?.services || []).filter((s) => s.active);

export const serviceByCode = (settings, code) =>
  activeServices(settings).find((s) => s.code === code) || null;

/**
 * The tariff a visit of this kind is normally billed under.
 *
 * A booking already records what the appointment is *for*, and reception was
 * being asked to translate that back into a tariff code by hand for every
 * invoice. This is that translation, written down once.
 *
 * Deliberately a suggestion and not a rule: the picker it feeds stays editable,
 * because the visit type is what was booked and the tariff is what was actually
 * done, and the two part company the moment a follow-up turns into a procedure.
 * Anything unrecognised falls back to the practice's established-patient visit,
 * which is the safest guess and the easiest for a biller to notice is wrong.
 */
const VISIT_TYPE_TARIFF = {
  'New patient consult': '99203',
  'Follow up': '99213',
  'Blood pressure review': '99213',
  'Postoperative check': '99213',
  'Cardiology follow up': '99214',
  'Cardiology review': '99214',
  'Lab review': '80053',
  'Medication review': '99212',
};

export function tariffForVisitType(settings, visitType) {
  const preferred = VISIT_TYPE_TARIFF[visitType];
  return (
    (preferred && serviceByCode(settings, preferred))
    || serviceByCode(settings, '99213')
    || activeServices(settings)[0]
    || null
  );
}
