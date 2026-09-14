/**
 * The service catalogue.
 *
 * What the practice does, and what it charges for doing it — held as data the
 * practice owns rather than as constants in the application. A clinician picks
 * "ECG"; everything downstream (billing description, department, price, tariff,
 * the split between scheme and patient) resolves from here.
 *
 * Three things are deliberate:
 *
 * **Prices are effective-dated, not a single number.** A practice that raises
 * its consultation fee in October must not silently re-price the invoice it
 * raised in August. `price` is therefore a list of periods and the current one
 * is resolved for a given date — the same rule the tariff catalogue uses, for
 * the same reason.
 *
 * **A service names its own default tariff, but only as a default.** The
 * payer-specific rate lives in the tariff catalogue. What sits here is what the
 * practice bills under when nothing more specific applies.
 *
 * **Aliases are first class.** External tariff schedules describe the same
 * procedure a dozen ways ("ECG", "12 Lead Resting ECG", "ECG ADULT"), and an
 * import has to resolve them back to one service. Recording them here is what
 * makes that deterministic rather than a guess.
 */

/**
 * When a service becomes billable.
 *
 * Deliberately three, not the ten a full hospital billing engine eventually
 * needs. There is no order entity, no dispensing, no admission and no sample
 * tracking in this system yet, so triggers for those would be settings that
 * look configurable and can never fire. Each one gets added when something
 * exists that can emit it.
 */
export const BILLING_TRIGGERS = [
  { value: 'ON_ORDER', label: 'When ordered', hint: 'Billed as soon as it is requested. Deposits and consumables.' },
  { value: 'ON_COMPLETION', label: 'On completion', hint: 'Billed once performed. The safe default.' },
  { value: 'MANUAL', label: 'Manual only', hint: 'Never billed automatically; a person raises it.' },
];

export const SERVICE_CATEGORIES = ['Consultation', 'Diagnostics', 'Pathology', 'Procedure', 'Review'];

export const triggerLabel = (value) =>
  BILLING_TRIGGERS.find((t) => t.value === value)?.label ?? value;

/** A price that has always applied, for services whose history predates the catalogue. */
const always = (amount, currency = 'USD') => [
  { amount, currency, effectiveFrom: '2020-01-01', effectiveTo: null },
];

/**
 * Seed catalogue, per practice.
 *
 * `visitTypes` is the replacement for what used to be a hardcoded
 * `VISIT_TYPE_TARIFF` map in `practiceSettings.js` — a lookup table in
 * application code that decided what a booking should be billed under. That is
 * exactly the sort of value a practice has to be able to change without a
 * deployment, so it lives on the service it points at.
 */
export const initialCatalogue = {
  'PRC-001': [
    {
      id: 'SVC-001', internalCode: 'CONS-EST', displayName: 'Consultation, established patient',
      clinicalName: 'Follow-up consultation', billingDescription: 'Office visit, established patient',
      category: 'Consultation', department: 'General Practice', serviceType: 'consultation',
      defaultDuration: 15, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '99213',
      price: always(40),
      visitTypes: ['Follow up', 'Blood pressure review', 'Postoperative check'],
      aliases: ['Office visit', 'GP consultation', 'Follow up consult', 'Established patient visit'],
      notes: '',
    },
    {
      id: 'SVC-002', internalCode: 'CONS-NEW', displayName: 'Consultation, new patient',
      clinicalName: 'New patient consultation', billingDescription: 'New patient consultation',
      category: 'Consultation', department: 'General Practice', serviceType: 'consultation',
      defaultDuration: 30, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '99203',
      price: always(45),
      visitTypes: ['New patient consult'],
      aliases: ['New patient', 'Initial consultation', 'First visit'],
      notes: '',
    },
    {
      id: 'SVC-003', internalCode: 'CONS-EXT', displayName: 'Extended review',
      clinicalName: 'Extended consultation', billingDescription: 'Extended review',
      category: 'Review', department: 'General Practice', serviceType: 'consultation',
      defaultDuration: 30, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '99214',
      price: always(75),
      visitTypes: ['Cardiology review', 'Cardiology follow up'],
      aliases: ['Specialist review', 'Extended consult', 'Cardiology review'],
      notes: '',
    },
    {
      id: 'SVC-004', internalCode: 'DIAG-ECG', displayName: 'ECG',
      clinicalName: 'Electrocardiogram', billingDescription: '12 lead resting ECG',
      category: 'Diagnostics', department: 'Diagnostics', serviceType: 'diagnostic',
      defaultDuration: 15, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '93000',
      // Re-priced in September. The August invoice in the billing seed still
      // resolves 20, which is the whole reason a price is a dated period
      // rather than a number.
      price: [
        { amount: 20, currency: 'USD', effectiveFrom: '2020-01-01', effectiveTo: '2026-08-31' },
        { amount: 35, currency: 'USD', effectiveFrom: '2026-09-01', effectiveTo: null },
      ],
      visitTypes: [],
      aliases: ['ECG', 'Electrocardiogram', '12 Lead ECG', 'Resting ECG', 'ECG ADULT', 'ECG REST'],
      notes: '',
    },
    {
      id: 'SVC-005', internalCode: 'PATH-MET', displayName: 'Metabolic panel',
      clinicalName: 'Comprehensive metabolic panel', billingDescription: 'Metabolic panel',
      category: 'Pathology', department: 'Laboratory', serviceType: 'pathology',
      defaultDuration: 10, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '80053',
      price: always(40),
      visitTypes: ['Lab review'],
      aliases: ['Metabolic panel', 'CMP', 'U&E', 'Chemistry panel'],
      notes: '',
    },
    {
      id: 'SVC-006', internalCode: 'CONS-MED', displayName: 'Medication review',
      clinicalName: 'Medication review', billingDescription: 'Medication review',
      category: 'Review', department: 'General Practice', serviceType: 'consultation',
      defaultDuration: 15, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '99212',
      price: always(25),
      visitTypes: ['Medication review'],
      aliases: ['Medication review', 'Script review', 'Repeat prescription'],
      notes: '',
    },
  ],
  'PRC-002': [
    {
      id: 'SVC-101', internalCode: 'CONS-EST', displayName: 'Consultation, established patient',
      clinicalName: 'Follow-up consultation', billingDescription: 'Office visit, established patient',
      category: 'Consultation', department: 'Family Medicine', serviceType: 'consultation',
      defaultDuration: 15, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '99213',
      price: always(25),
      visitTypes: ['Follow up', 'Blood pressure review', 'Postoperative check'],
      aliases: ['Office visit', 'GP consultation'],
      notes: '',
    },
    {
      id: 'SVC-102', internalCode: 'CONS-NEW', displayName: 'Consultation, new patient',
      clinicalName: 'New patient consultation', billingDescription: 'New patient consultation',
      category: 'Consultation', department: 'Family Medicine', serviceType: 'consultation',
      defaultDuration: 30, defaultQuantity: 1, active: true, billable: true,
      billingTrigger: 'ON_COMPLETION', defaultTariffCode: '99203',
      price: always(40),
      visitTypes: ['New patient consult'],
      aliases: ['New patient', 'Initial consultation'],
      notes: '',
    },
  ],
};
