// Claim lifecycle against the NH263 biometric claims switch.
// Draft → biometric member verification → real-time submission → switch adjudication → remittance.
export const claimStatusFlow = ['Draft', 'Ready for submission', 'Submitted', 'Processing', 'Approved'];

export const claimStatusTone = {
  'Draft': 'neutral',
  'Form prepared': 'accent',
  'Awaiting client authentication': 'warm',
  'Client authenticated': 'accent',
  'Email submitted': 'warm',
  'Ready': 'accent',
  'Validation failed': 'alert',
  'Ready for submission': 'accent',
  'Submitting': 'warm',
  'Biometric verified': 'accent',
  'Submitted': 'warm',
  'Acknowledged': 'warm',
  'Processing': 'warm',
  'Adjudicated': 'success',
  'Approved': 'success',
  'Partially approved': 'warm',
  'Remitted': 'success',
  'Rejected': 'alert',
  'Query': 'warm',
  'Requires action': 'alert',
  'Failed': 'alert',
};

export const initialClaims = [
  {
    id: 'CLM-2026-0150',
    patient: 'Nyasha Chari',
    memberNo: 'BUPA-GLOBAL-774201',
    plan: 'Bupa Global',
    payerName: 'Bupa Global Claims',
    provider: 'Dr. Chen',
    serviceDate: 'Aug 24',
    amount: 'USD 185.00',
    invoice: 'INV-2026-015',
    tariff: '99203 · International new patient consult',
    icd10: 'J20.9, Acute bronchitis, unspecified',
    status: 'Form prepared',
    biometric: 'Not required',
    eligibility: 'International cover · claim-by-email',
    submissionChannel: 'Email',
    emailSubmission: {
      providerEmail: 'globalclaims@bupa.example',
      claimForm: 'Bupa Global member claim form',
      preparedBy: 'Luminary Health admin',
      reviewLink: 'Secure client review link generated',
      authenticationMethod: 'OTP + declaration',
      authentication: 'Not authenticated',
      requiredDocuments: ['Claim form', 'Itemised invoice', 'Clinical notes', 'Proof of payment'],
      attachments: ['Claim form draft', 'INV-2026-015 itemised invoice', 'Consultation note'],
      subject: 'Claim CLM-2026-0150 · Nyasha Chari · BUPA-GLOBAL-774201',
      followUp: '3 business days after submission',
    },
    responses: [
      { label: 'Provider-specific claim form prepared by Luminary admin', time: 'Aug 24, 16:10', tone: 'success' },
      { label: 'Waiting for member review and OTP declaration', time: 'Aug 24, 16:11', tone: 'warm' },
    ],
  },
  {
    id: 'CLM-2026-0148',
    patient: 'Ruvimbo Moyo',
    memberNo: 'NH263-004821-00',
    plan: 'NH263 Plan A',
    provider: 'Dr. Chen',
    serviceDate: 'Aug 19',
    amount: 'USD 60.00',
    invoice: 'INV-2026-013',
    tariff: '99213 · Office visit, established',
    icd10: 'I10, Essential hypertension',
    status: 'Draft',
    biometric: 'Not captured',
    eligibility: 'Active · Benefits available',
    responses: [],
  },
  {
    id: 'CLM-2026-0147',
    patient: 'Tawanda Mutsvangwa',
    memberNo: 'NH263-011302-01',
    plan: 'NH263 Plan C',
    provider: 'Dr. Ahmed',
    serviceDate: 'Aug 14',
    amount: 'USD 115.00',
    invoice: 'INV-2026-014',
    tariff: '99203 · New patient consult',
    icd10: 'G43.909, Migraine, unspecified',
    status: 'Biometric verified',
    biometric: 'Fingerprint matched · 08:41',
    eligibility: 'Active · Benefits available',
    responses: [{ label: 'Member verified at terminal BIO-02', time: '08:41', tone: 'success' }],
  },
  {
    id: 'CLM-2026-0146',
    patient: 'Tariro Gumbo',
    memberNo: 'NH263-007754-00',
    plan: 'NH263 Plan B',
    provider: 'Dr. Park',
    serviceDate: 'Aug 16',
    amount: 'USD 75.00',
    invoice: 'INV-2026-011',
    tariff: '99214 · Cardiology review',
    icd10: 'I25.10, Chronic ischemic heart disease',
    status: 'Submitted',
    biometric: 'Fingerprint matched · Aug 24, 12:22',
    eligibility: 'Active · Pre-auth attached (PA-3391)',
    responses: [
      { label: 'Member verified at terminal BIO-01', time: 'Aug 24, 12:22', tone: 'success' },
      { label: 'Claim accepted by switch · Ref SW-88214', time: 'Aug 24, 12:23', tone: 'success' },
      { label: 'Awaiting adjudication', time: 'Aug 24, 12:23', tone: 'warm' },
    ],
  },
  {
    id: 'CLM-2026-0144',
    patient: 'Kudzai Machingura',
    memberNo: 'NH263-009910-02',
    plan: 'NH263 Plan A',
    provider: 'Dr. Singh',
    serviceDate: 'Aug 09',
    amount: 'USD 40.00',
    invoice: 'INV-2026-009',
    tariff: '80053 · Metabolic panel',
    icd10: 'E66.9, Obesity, unspecified',
    status: 'Adjudicated',
    biometric: 'Fingerprint matched · Aug 22, 15:04',
    eligibility: 'Active · Benefits available',
    responses: [
      { label: 'Member verified at terminal BIO-02', time: 'Aug 22, 15:04', tone: 'success' },
      { label: 'Claim accepted by switch · Ref SW-88102', time: 'Aug 22, 15:05', tone: 'success' },
      { label: 'Adjudicated: USD 36.00 approved, USD 4.00 member portion', time: 'Aug 23, 09:12', tone: 'success' },
    ],
  },
  {
    id: 'CLM-2026-0141',
    patient: 'Chiedza Mutasa',
    memberNo: 'NH263-006233-00',
    plan: 'NH263 Plan B',
    provider: 'Dr. Park',
    serviceDate: 'Aug 20',
    amount: 'USD 75.00',
    invoice: 'INV-2026-012',
    tariff: '99214 · Cardiology review',
    icd10: 'I48.91, Atrial fibrillation',
    status: 'Rejected',
    rejectionCode: 'R204',
    // Already moved — the invoice below carries the full amount as patient
    // responsibility. Recorded so the workspace does not offer to move it again.
    movedToPatient: true,
    biometric: 'Fingerprint matched · Aug 20, 11:37',
    eligibility: 'Suspended · Contributions in arrears',
    responses: [
      { label: 'Member verified at terminal BIO-01', time: 'Aug 20, 11:37', tone: 'success' },
      { label: 'Rejected: R204, membership suspended', time: 'Aug 20, 11:38', tone: 'alert' },
      { label: 'Moved to patient responsibility · invoice INV-2026-012', time: 'Aug 20, 11:40', tone: 'neutral' },
    ],
  },
];

/**
 * Invoice balances reconcile to each patient's balance in the registry above.
 *
 * `issuedOn` and `dueOn` are ISO dates alongside the display strings, because
 * aging is arithmetic and "Sep 13" is not. The display strings stay for the
 * places that only ever print them; nothing derives a bucket from a label.
 *
 * The cohort deliberately spans every aging bucket. A receivables report that
 * only ever shows one column proves nothing about whether the boundaries are
 * right, and the two accounts that matter to a practice manager — Chiedza Mutasa,
 * two open invoices after a claim rejection, and Tendai Moyo at 90+ — are the
 * ones a statement and a write-off exist for.
 */
export const initialInvoices = [
  { id: 'INV-2026-014', patient: 'Tawanda Mutsvangwa', date: 'Aug 14', issuedOn: '2026-08-14', dueDate: 'Sep 13', dueOn: '2026-09-13', amount: 115, currency: 'USD', status: 'Pending', tone: 'warm', claim: 'CLM-2026-0147', claimStatus: 'Submitted', services: [{ desc: 'New patient consult', code: '99203', quantity: 1, unitPrice: 45, amount: 45, gross: 45, insurance: 36, estimatedFunder: 36, estimatedPatient: 9, actualFunderApproved: null, actualFunderPaid: null }, { desc: 'Neurology assessment', code: '99214', quantity: 1, unitPrice: 70, amount: 70, gross: 70, insurance: 56, estimatedFunder: 56, estimatedPatient: 14, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 23, insurance: 'NH263 Plan C', payments: [], adjustments: [] },
  { id: 'INV-2026-013', patient: 'Ruvimbo Moyo', date: 'Aug 19', issuedOn: '2026-08-19', dueDate: 'Sep 18', dueOn: '2026-09-18', amount: 60, currency: 'USD', status: 'Pending', tone: 'warm', claim: 'CLM-2026-0148', claimStatus: 'Draft', services: [{ desc: 'Office visit, established', code: '99213', quantity: 1, unitPrice: 40, amount: 40, gross: 40, insurance: 34, estimatedFunder: 34, estimatedPatient: 6, tariffVia: 'plan tariff', actualFunderApproved: null, actualFunderPaid: null }, { desc: 'ECG, routine', code: '93000', quantity: 1, unitPrice: 20, amount: 20, gross: 20, insurance: 20, estimatedFunder: 20, estimatedPatient: 0, tariffVia: 'plan tariff', actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 6, insurance: 'NH263 Plan A', payments: [], adjustments: [] },
  // The claim was rejected on the day of service and the balance moved to the
  // patient, so it fell due then — not thirty days later. A rejection does not
  // buy the practice a month of credit it never extended.
  { id: 'INV-2026-012', patient: 'Chiedza Mutasa', date: 'Aug 20', issuedOn: '2026-08-20', dueDate: 'Aug 20', dueOn: '2026-08-20', amount: 75, currency: 'USD', status: 'Overdue', tone: 'alert', claim: 'CLM-2026-0141', claimStatus: 'Rejected', services: [{ desc: 'Cardiology review', code: '99214', quantity: 1, unitPrice: 75, amount: 75, gross: 75, insurance: 0, estimatedFunder: 0, estimatedPatient: 75, actualFunderApproved: 0, actualFunderPaid: 0 }], patientResponsibility: 75, insurance: 'NH263 Plan B', payments: [], adjustments: [] },
  { id: 'INV-2026-011', patient: 'Tariro Gumbo', date: 'Aug 16', issuedOn: '2026-08-16', dueDate: 'Sep 15', dueOn: '2026-09-15', amount: 75, currency: 'USD', status: 'Pending', tone: 'warm', claim: 'CLM-2026-0146', claimStatus: 'Submitted', services: [{ desc: 'Cardiology review', code: '99214', quantity: 1, unitPrice: 75, amount: 75, gross: 75, insurance: 60, estimatedFunder: 60, estimatedPatient: 15, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 15, insurance: 'NH263 Plan B', payments: [], adjustments: [] },
  { id: 'INV-2026-010', patient: 'Farai Nyamande', date: 'Aug 18', issuedOn: '2026-08-18', dueDate: 'Sep 17', dueOn: '2026-09-17', amount: 50, currency: 'USD', status: 'Pending', tone: 'warm', claim: 'CLM-2026-0145', claimStatus: 'Adjudicated', services: [{ desc: 'Postoperative visit', code: '99024', quantity: 1, unitPrice: 50, amount: 50, gross: 50, insurance: 45, estimatedFunder: 45, estimatedPatient: 5, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 5, insurance: 'NH263 Plan A', payments: [], adjustments: [] },
  { id: 'INV-2026-009', patient: 'Kudzai Machingura', date: 'Aug 09', issuedOn: '2026-08-09', dueDate: 'Sep 08', dueOn: '2026-09-08', amount: 40, currency: 'USD', status: 'Paid', tone: 'success', claim: 'CLM-2026-0144', claimStatus: 'Adjudicated', services: [{ desc: 'Metabolic panel', code: '80053', quantity: 1, unitPrice: 40, amount: 40, gross: 40, insurance: 36, estimatedFunder: 36, estimatedPatient: 4, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 4, insurance: 'NH263 Plan A', payments: [{ id: 'PAY-20260823A', amount: 4, currency: 'USD', fxRate: 1, method: 'cash', receivedAt: '2026-08-23T09:40:00.000Z', receivedBy: 'R. Chikafu', reversesId: null }], adjustments: [] },
  { id: 'INV-2026-008', patient: 'Tendai Moyo', date: 'Aug 21', issuedOn: '2026-08-21', dueDate: 'Sep 20', dueOn: '2026-09-20', amount: 25, currency: 'USD', status: 'Pending', tone: 'warm', claim: 'CLM-2026-0149', claimStatus: 'Draft', services: [{ desc: 'Medication review', code: '99212', quantity: 1, unitPrice: 25, amount: 25, gross: 25, insurance: 20, estimatedFunder: 20, estimatedPatient: 5, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 5, insurance: 'NH263 Plan C', payments: [], adjustments: [] },
  // Chiedza's second open invoice. One patient, two debts, in two different aging
  // buckets — which is exactly the account a per-invoice screen cannot answer
  // "what do I owe you?" for.
  { id: 'INV-2026-006', patient: 'Chiedza Mutasa', date: 'Jun 28', issuedOn: '2026-06-28', dueDate: 'Jul 28', dueOn: '2026-07-28', amount: 120, currency: 'USD', status: 'Overdue', tone: 'alert', claim: 'CLM-2026-0122', claimStatus: 'Rejected', services: [{ desc: 'Holter monitor fitting', code: '93224', quantity: 1, unitPrice: 120, amount: 120, gross: 120, insurance: 24, estimatedFunder: 24, estimatedPatient: 96, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 96, insurance: 'NH263 Plan B', payments: [], adjustments: [] },
  { id: 'INV-2026-005', patient: 'Farai Nyamande', date: 'May 30', issuedOn: '2026-05-30', dueDate: 'Jun 29', dueOn: '2026-06-29', amount: 100, currency: 'USD', status: 'Overdue', tone: 'alert', claim: 'CLM-2026-0108', claimStatus: 'Rejected', services: [{ desc: 'Physiotherapy, initial', code: '97161', quantity: 1, unitPrice: 100, amount: 100, gross: 100, insurance: 20, estimatedFunder: 20, estimatedPatient: 80, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 80, insurance: 'NH263 Plan A', payments: [], adjustments: [] },
  // Past ninety days with no cover behind it. Nothing on this screen could
  // discharge this balance until write-offs existed; it would have aged for
  // ever, quietly overstating what the practice is owed.
  { id: 'INV-2026-004', patient: 'Tendai Moyo', date: 'Apr 02', issuedOn: '2026-04-02', dueDate: 'May 02', dueOn: '2026-05-02', amount: 150, currency: 'USD', status: 'Overdue', tone: 'alert', claim: 'CLM-2026-0091', claimStatus: 'Rejected', services: [{ desc: 'Minor procedure, lesion removal', code: '11402', quantity: 1, unitPrice: 150, amount: 150, gross: 150, insurance: 0, estimatedFunder: 0, estimatedPatient: 150, actualFunderApproved: null, actualFunderPaid: null }], patientResponsibility: 150, insurance: 'Self-pay · membership lapsed', payments: [], adjustments: [] },
];

/**
 * NH263 rejection codes the switch actually returns.
 *
 * Kept as data rather than free text so a rejection can be reasoned about:
 * a suspended membership becomes the patient's debt, while a coding error is
 * corrected and resubmitted. The workspace shows the code and the reason
 * together, because "R204" alone tells reception nothing.
 */
export const REJECTION_REASONS = {
  R204: 'membership suspended',
  R118: 'benefit exhausted for this period',
  R091: 'no pre-authorisation on file',
  R305: 'tariff not covered by this plan',
  R402: 'diagnosis inconsistent with the tariff billed',
};
