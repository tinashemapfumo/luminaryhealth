/**
 * The permission matrix.
 *
 * Deliberately free of imports. It was extracted from `access.js` — which
 * pulls in icon components for the navigation — so that this file can be read
 * by something with no React and no bundler: specifically the contract test in
 * `luminary-server`, which asserts this agrees with the server's copy.
 *
 * The duplication with `luminary-server/src/platform/permissions.ts` is
 * intentional. This copy decides what to *draw*; that copy decides what is
 * *allowed*. Sharing one module would invite someone to treat a single check as
 * covering both, and hiding a button is not access control. What the duplication
 * must not do is *drift*, which is what the contract test is for.
 *
 * Permissions are split by the kind of harm getting them wrong would cause, not
 * by seniority. Administrative data (demographics, cover) and clinical data
 * (notes, prescriptions) are separate grants, and reading a clinical note is its
 * own permission — a practice manager runs the business without needing to read
 * what a patient told their doctor.
 *
 * The same reasoning separates *running the system* from *using it*. A practice
 * IT administrator provisions accounts and configures the platform; none of that
 * requires seeing a patient exists, let alone reading a consultation.
 */
export const PERMISSIONS = [
  // Administrative
  { key: 'viewPatientDirectory', label: 'See patient records exist', group: 'Administrative' },
  { key: 'addPatient', label: 'Register patients', group: 'Administrative' },
  { key: 'editDemographics', label: 'Edit demographics and contact', group: 'Administrative' },
  { key: 'editCover', label: 'Edit medical aid cover', group: 'Administrative' },
  { key: 'scheduleVisit', label: 'Schedule visits', group: 'Administrative' },
  { key: 'checkIn', label: 'Check patients in', group: 'Administrative' },
  // Clinical
  { key: 'viewClinicalNotes', label: 'Read clinical notes', group: 'Clinical' },
  { key: 'recordVitals', label: 'Record vitals', group: 'Clinical' },
  { key: 'writeNote', label: 'Draft encounter notes', group: 'Clinical' },
  { key: 'signNote', label: 'Sign encounter notes', group: 'Clinical' },
  { key: 'amendNote', label: 'Add addenda to signed notes', group: 'Clinical' },
  { key: 'prescribe', label: 'Prescribe medication', group: 'Clinical' },
  { key: 'orderLabs', label: 'Order investigations', group: 'Clinical' },
  { key: 'orderServices', label: 'Order catalogue services', group: 'Clinical' },
  { key: 'editClinicalHistory', label: 'Edit allergies, conditions, history', group: 'Clinical' },
  { key: 'captureEncounterServices', label: 'Capture services performed in a consultation', group: 'Clinical' },
  // Financial
  { key: 'createInvoice', label: 'Raise invoices', group: 'Financial' },
  { key: 'recordPayment', label: 'Record payments and receipts', group: 'Financial' },
  { key: 'readClaims', label: 'Read medical aid claims', group: 'Financial' },
  { key: 'createClaims', label: 'Create medical aid claims', group: 'Financial' },
  { key: 'editClaims', label: 'Edit draft claims', group: 'Financial' },
  { key: 'submitClaims', label: 'Submit NH263 claims', group: 'Financial' },
  { key: 'refreshClaimStatus', label: 'Refresh claim status', group: 'Financial' },
  { key: 'manageClaimAttachments', label: 'Manage claim attachments', group: 'Financial' },
  { key: 'viewClaimTransmissions', label: 'View claim transmissions', group: 'Financial' },
  { key: 'adminClaims', label: 'Administer claims engine', group: 'Financial' },
  { key: 'captureBiometric', label: 'Capture patient biometrics', group: 'Financial' },
  { key: 'adjustBalance', label: 'Write off and credit balances', group: 'Financial' },
  { key: 'manageTariffs', label: 'Publish medical aid tariffs', group: 'Financial' },
  { key: 'viewBillingHandoff', label: 'View the billing handoff queue', group: 'Financial' },
  { key: 'editDraftInvoice', label: 'Edit draft invoices', group: 'Financial' },
  { key: 'addCatalogueInvoiceLine', label: 'Add catalogue lines to a draft invoice', group: 'Financial' },
  { key: 'addCustomInvoiceLine', label: 'Add a custom or miscellaneous invoice line', group: 'Financial' },
  { key: 'excludeAutomatedInvoiceLine', label: 'Exclude an automatically proposed invoice line', group: 'Financial' },
  { key: 'overrideInvoicePrice', label: 'Override an invoice line price', group: 'Financial' },
  { key: 'approveBespokePrice', label: 'Approve a bespoke price agreement', group: 'Financial' },
  { key: 'finalizeInvoice', label: 'Finalize invoices', group: 'Financial' },
  { key: 'requestBillingClarification', label: 'Request or answer billing clarifications', group: 'Financial' },
  // Platform
  { key: 'sendMessages', label: 'Message patients', group: 'Platform' },
  { key: 'manageAgents', label: 'Manage AI agents', group: 'Platform' },
  { key: 'exportReports', label: 'Export reports', group: 'Platform' },
  { key: 'exportPatientRecord', label: 'Export patient records', group: 'Clinical' },
  // Administration — running the system, not using it
  { key: 'manageUsers', label: 'Add and deactivate users', group: 'Administration' },
  { key: 'assignRoles', label: 'Assign roles', group: 'Administration' },
  { key: 'manageConfiguration', label: 'Configure the practice', group: 'Administration' },
  { key: 'manageIntegrations', label: 'Manage NH263 and gateway credentials', group: 'Administration' },
  { key: 'manageCover', label: 'Set leave and covering arrangements', group: 'Administration' },
  { key: 'reviewAudit', label: 'Review the audit log', group: 'Administration' },
];

/** Nobody may grant themselves a permission they do not already hold. */
export const SELF_ELEVATION_BLOCKED = [
  'prescribe', 'signNote', 'amendNote', 'orderLabs',
  'createInvoice', 'recordPayment', 'readClaims', 'createClaims', 'editClaims', 'submitClaims',
  'refreshClaimStatus', 'manageClaimAttachments', 'viewClaimTransmissions', 'adminClaims',
  'adjustBalance', 'manageTariffs',
  'viewClinicalNotes', 'viewPatientDirectory',
  'excludeAutomatedInvoiceLine', 'overrideInvoicePrice', 'approveBespokePrice', 'finalizeInvoice',
];

/**
 * Every permission set to false, so each role below states what it grants
 * rather than restating the whole matrix. A permission added to `PERMISSIONS`
 * and forgotten here is therefore denied by default — the safe direction, and
 * the contract test catches it either way.
 */
const NONE = Object.fromEntries(PERMISSIONS.map((p) => [p.key, false]));

export const roleAccess = {
  // The practice IT administrator. Provisions accounts and configures the
  // platform — and deliberately cannot see that a patient exists, let alone
  // read a consultation. Running the system is not a clinical role.
  admin: {
    views: ['dashboard', 'settings', 'audit', 'reports', 'ai'],
    can: {
      ...NONE,
      manageAgents: true, exportReports: true,
      manageUsers: true, assignRoles: true, manageConfiguration: true,
      manageIntegrations: true, manageCover: true, reviewAudit: true,
      viewClaimTransmissions: true, adminClaims: true,
    },
    scopeNote: 'Practice administration: user accounts, configuration, integrations, and the audit log. Patient and clinical data are deliberately out of scope: provisioning an account never requires reading a consultation. Open a chart only through break glass, and only with a stated reason.',
    ownPatientsOnly: false,
  },
  doctor: {
    views: ['dashboard', 'patients', 'appointments', 'clinical', 'orders', 'communications', 'ai'],
    can: {
      ...NONE,
      viewPatientDirectory: true, scheduleVisit: true,
      viewClinicalNotes: true, recordVitals: true, writeNote: true, signNote: true, amendNote: true,
      prescribe: true, orderLabs: true, orderServices: true, editClinicalHistory: true,
      readClaims: true, manageClaimAttachments: true,
      sendMessages: true, exportPatientRecord: true,
      viewBillingHandoff: true, captureEncounterServices: true, requestBillingClarification: true,
    },
    scopeNote: 'Clinical practice: your clinic list, encounter notes, prescribing, and investigations. Demographics and cover are maintained by reception; billing and claims are handled by the practice manager.',
    ownPatientsOnly: true,
  },
  nurse: {
    views: ['dashboard', 'patients', 'appointments', 'clinical', 'orders', 'claims', 'communications', 'ai'],
    can: {
      ...NONE,
      viewPatientDirectory: true, addPatient: true, editDemographics: true,
      scheduleVisit: true, checkIn: true,
      viewClinicalNotes: true, recordVitals: true, writeNote: true, editClinicalHistory: true,
      orderServices: true, readClaims: true, manageClaimAttachments: true,
      captureBiometric: true, sendMessages: true,
      viewBillingHandoff: true, captureEncounterServices: true, requestBillingClarification: true,
    },
    scopeNote: 'Care operations: intake, check in, vitals, allergy and history review, and biometric capture. You can draft a note for a clinician to sign, but cannot sign it, prescribe, or order investigations.',
    ownPatientsOnly: false,
  },
  manager: {
    views: ['dashboard', 'patients', 'appointments', 'billing', 'orders', 'claims', 'tariffs', 'communications', 'reports', 'ai', 'audit'],
    can: {
      ...NONE,
      viewPatientDirectory: true, addPatient: true, editDemographics: true, editCover: true,
      scheduleVisit: true, checkIn: true,
      createInvoice: true, recordPayment: true, readClaims: true, createClaims: true, editClaims: true,
      submitClaims: true, refreshClaimStatus: true, manageClaimAttachments: true, viewClaimTransmissions: true,
      adjustBalance: true,
      manageTariffs: true,
      sendMessages: true, manageAgents: true, exportReports: true, exportPatientRecord: true,
      manageCover: true, reviewAudit: true,
      viewBillingHandoff: true, editDraftInvoice: true, addCatalogueInvoiceLine: true,
      addCustomInvoiceLine: true, excludeAutomatedInvoiceLine: true, overrideInvoicePrice: true,
      approveBespokePrice: true, finalizeInvoice: true, requestBillingClarification: true,
    },
    scopeNote: 'Operations and revenue: scheduling, billing, claims, campaigns, and analytics. Clinical notes are deliberately out of scope: running the practice does not require reading consultations.',
    ownPatientsOnly: false,
  },
  receptionist: {
    views: ['dashboard', 'patients', 'appointments', 'billing', 'claims', 'communications'],
    can: {
      ...NONE,
      viewPatientDirectory: true, addPatient: true, editDemographics: true, editCover: true,
      scheduleVisit: true, checkIn: true,
      createInvoice: true, recordPayment: true, readClaims: true, createClaims: true, editClaims: true,
      submitClaims: true, refreshClaimStatus: true, manageClaimAttachments: true,
      captureBiometric: true,
      sendMessages: true,
      // Deliberately no adjustBalance. Reception takes money in; deciding the
      // practice will never collect a debt is a different kind of decision,
      // and letting the same person do both removes the only check on it.
      viewBillingHandoff: true, editDraftInvoice: true, addCatalogueInvoiceLine: true,
      finalizeInvoice: true, requestBillingClarification: true,
    },
    scopeNote: 'Front desk operations: patient registration, demographics, cover, scheduling, check in, payments, claims, and reminders. Clinical notes, prescribing, reporting, audit review, and system settings are deliberately out of scope.',
    ownPatientsOnly: false,
  },
};

export const metricScopeByRole = {
  admin: ['all', 'finance', 'clinical'],
  manager: ['all', 'finance'],
  receptionist: ['all', 'finance'],
  doctor: ['all', 'clinical'],
  nurse: ['all', 'clinical'],
};
