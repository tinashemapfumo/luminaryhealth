/**
 * Tenancy and identity.
 *
 * A practice is a hard boundary: no user, permission, or break-glass may ever
 * reach across it. Everything else — role, care relationship, temporary grant —
 * operates strictly inside one practice.
 *
 * Passwords here are plaintext demo credentials. That is acceptable only
 * because nothing is enforced client-side anyway; real authentication belongs
 * on the server, and this file becomes a seed script.
 */

export const practices = [
  {
    id: 'PRC-001',
    name: 'Harare Family Health Demo',
    short: 'Harare Demo',
    location: 'Avondale, Harare',
    plan: 'Enterprise',
  },
];

/**
 * Seeded users. `role` maps onto the existing roleAccess permission matrix;
 * identity and permissions stay separate so a practice can have three doctors
 * with identical permissions but entirely different patient lists.
 */
export const users = [
  // ---- Harare Family Health Demo ----
  {
    id: 'USR-001', practiceId: 'PRC-001', role: 'doctor',
    name: 'Dr. Chen', fullName: 'Dr. Mei Chen', initials: 'MC',
    email: 'm.chen@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'General Practitioner', hpcz: 'HPCZ-GP-4471',
  },
  {
    id: 'USR-002', practiceId: 'PRC-001', role: 'doctor',
    name: 'Dr. Ahmed', fullName: 'Dr. Yusuf Ahmed', initials: 'YA',
    email: 'y.ahmed@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'General Practitioner', hpcz: 'HPCZ-GP-3902',
  },
  {
    id: 'USR-003', practiceId: 'PRC-001', role: 'doctor',
    name: 'Dr. Park', fullName: 'Dr. Soo-jin Park', initials: 'SP',
    email: 's.park@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'Cardiologist', hpcz: 'HPCZ-SP-1180',
  },
  {
    id: 'USR-004', practiceId: 'PRC-001', role: 'doctor',
    name: 'Dr. Singh', fullName: 'Dr. Amrit Singh', initials: 'AS',
    email: 'a.singh@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'General Practitioner', hpcz: 'HPCZ-GP-5514',
    onLeave: true, leaveUntil: '2026-09-05',
  },
  {
    id: 'USR-005', practiceId: 'PRC-001', role: 'nurse',
    name: 'S. Moyo, RN', fullName: 'Sibongile Moyo', initials: 'SM',
    email: 's.moyo@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'Registered Nurse', hpcz: 'HPCZ-RN-2260',
  },
  {
    id: 'USR-006', practiceId: 'PRC-001', role: 'manager',
    name: 'R. Chikafu', fullName: 'Rutendo Chikafu', initials: 'RC',
    email: 'r.chikafu@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'Practice Manager',
  },
  {
    id: 'USR-008', practiceId: 'PRC-001', role: 'receptionist',
    name: 'N. Dhlamini', fullName: 'Nomsa Dhlamini', initials: 'ND',
    email: 'n.dhlamini@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'Receptionist',
  },
  {
    id: 'USR-007', practiceId: 'PRC-001', role: 'admin',
    name: 'T. Mapfumo', fullName: 'Tinashe Mapfumo', initials: 'TM',
    email: 't.mapfumo@demo.luminaryhealth.test', password: 'luminary',
    jobTitle: 'System Administrator',
  },

];

export const findUserByEmail = (email) =>
  users.find((u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase());

export const usersInPractice = (practiceId) => users.filter((u) => u.practiceId === practiceId);

export const practiceById = (id) => practices.find((p) => p.id === id);

/**
 * Explicit, time-bounded access grants — the answer to "Dr. Singh is on leave,
 * who covers his list?" Ownership cannot express that; a grant with a reason
 * and an expiry can.
 */
export const initialGrants = [
  {
    id: 'GRANT-001',
    practiceId: 'PRC-001',
    userId: 'USR-002',          // Dr. Ahmed
    patientId: 'PT-4450',       // Kudzai Machingura, normally Dr. Singh's
    type: 'Covering',
    reason: 'Dr. Singh on leave until 5 September',
    grantedBy: 'R. Chikafu',
    until: '2026-09-05',
  },
];

export const RELATIONSHIP = {
  PRIMARY: 'Primary provider',
  APPOINTMENT: 'Booked with you',
  AUTHOR: 'You authored a note',
  GRANT: 'Temporary access',
  BREAK_GLASS: 'Break-glass access',
};

/** Audit severities drive how loudly an entry is rendered in the log. */
export const AUDIT = {
  INFO: 'info',
  NOTICE: 'notice',
  ALERT: 'alert',
};

