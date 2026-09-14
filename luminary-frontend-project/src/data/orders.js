/**
 * Clinical orders.
 *
 * An order is what a clinician decided should happen. It is deliberately not a
 * billing record: the doctor asks for an ECG, and whether that has yet become
 * money depends on what has actually been done to the patient.
 *
 * Keeping the two apart is the whole point. Billing on the *order* charges
 * people for tests that were cancelled, declined by the lab, or never
 * performed — which is both a refund queue and, in a country where most people
 * pay cash at the desk, a reason not to come back.
 */

export const ORDER_STATUS = {
  ORDERED: 'Ordered',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  DECLINED: 'Declined',
};

/** The ordinary path. Cancelled and declined leave it rather than extend it. */
export const orderStatusFlow = [
  ORDER_STATUS.ORDERED,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.IN_PROGRESS,
  ORDER_STATUS.COMPLETED,
];

export const orderStatusTone = {
  [ORDER_STATUS.ORDERED]: 'neutral',
  [ORDER_STATUS.ACCEPTED]: 'accent',
  [ORDER_STATUS.IN_PROGRESS]: 'warm',
  [ORDER_STATUS.COMPLETED]: 'success',
  [ORDER_STATUS.CANCELLED]: 'alert',
  [ORDER_STATUS.DECLINED]: 'alert',
};

export const ORDER_PRIORITIES = ['Routine', 'Urgent', 'Stat'];

/**
 * Seed orders, chosen to exercise the states that matter to billing rather
 * than to fill a list: one completed and billed, one completed and not yet
 * billed, one still in progress, and one cancelled — which must never
 * produce a charge however many times the engine runs.
 */
export const initialOrders = [
  {
    id: 'ORD-2026-0041', practiceId: 'PRC-001',
    patientId: 'PT-2048', patientName: 'Ruvimbo Moyo',
    serviceId: 'SVC-004', serviceName: 'ECG',
    department: 'Diagnostics', quantity: 1, priority: 'Routine',
    orderedBy: 'Dr. Chen', orderedAt: '2026-08-19T09:12:00.000Z',
    status: ORDER_STATUS.COMPLETED,
    completedAt: '2026-08-19T10:04:00.000Z', completedBy: 'S. Moyo',
    clinicalNotes: 'Palpitations on exertion.',
    cancellationReason: null,
    invoiceId: 'INV-2026-013', billedKey: 'ORD-2026-0041:ON_COMPLETION',
  },
  {
    id: 'ORD-2026-0044', practiceId: 'PRC-001',
    patientId: 'PT-1681', patientName: 'Tariro Gumbo',
    serviceId: 'SVC-005', serviceName: 'Metabolic panel',
    department: 'Laboratory', quantity: 1, priority: 'Routine',
    orderedBy: 'Dr. Park', orderedAt: '2026-08-28T08:30:00.000Z',
    status: ORDER_STATUS.COMPLETED,
    completedAt: '2026-08-28T11:15:00.000Z', completedBy: 'S. Moyo',
    clinicalNotes: 'Annual review bloods.',
    cancellationReason: null,
    invoiceId: null, billedKey: null,
  },
  {
    id: 'ORD-2026-0045', practiceId: 'PRC-001',
    patientId: 'PT-3304', patientName: 'Tawanda Mutsvangwa',
    serviceId: 'SVC-004', serviceName: 'ECG',
    department: 'Diagnostics', quantity: 1, priority: 'Urgent',
    orderedBy: 'Dr. Ahmed', orderedAt: '2026-08-31T14:02:00.000Z',
    status: ORDER_STATUS.IN_PROGRESS,
    completedAt: null, completedBy: null,
    clinicalNotes: 'Chest tightness, rule out ischaemia.',
    cancellationReason: null,
    invoiceId: null, billedKey: null,
  },
  {
    id: 'ORD-2026-0046', practiceId: 'PRC-001',
    patientId: 'PT-5107', patientName: 'Farai Nyamande',
    serviceId: 'SVC-005', serviceName: 'Metabolic panel',
    department: 'Laboratory', quantity: 1, priority: 'Routine',
    orderedBy: 'Dr. Chen', orderedAt: '2026-08-30T09:45:00.000Z',
    status: ORDER_STATUS.CANCELLED,
    completedAt: null, completedBy: null,
    clinicalNotes: 'Duplicate of the panel run last week.',
    cancellationReason: 'Ordered in error, duplicate request',
    invoiceId: null, billedKey: null,
  },
];
