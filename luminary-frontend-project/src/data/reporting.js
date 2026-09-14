import { carePlansByPatient } from './clinical';

export const revenueTrend = [
  { month: 'Mar', value: 31.2 },
  { month: 'Apr', value: 34.5 },
  { month: 'May', value: 33.1 },
  { month: 'Jun', value: 38.7 },
  { month: 'Jul', value: 40.2 },
  { month: 'Aug', value: 42.8 },
];

export const noShowTrend = [
  { week: 'W1', rate: 7.2 },
  { week: 'W2', rate: 6.4 },
  { week: 'W3', rate: 6.1 },
  { week: 'W4', rate: 5.5 },
  { week: 'W5', rate: 5.0 },
  { week: 'W6', rate: 4.8 },
];

export const providerProductivity = [
  { provider: 'Dr. Chen', visits: 86, revenue: 'USD 380', utilization: 94, noShow: '3.1%' },
  { provider: 'Dr. Ahmed', visits: 74, revenue: 'USD 310', utilization: 88, noShow: '4.6%' },
  { provider: 'Dr. Park', visits: 69, revenue: 'USD 348', utilization: 91, noShow: '5.2%' },
  { provider: 'Dr. Singh', visits: 61, revenue: 'USD 274', utilization: 82, noShow: '6.0%' },
];

export const payerMix = [
  { payer: 'NH263 insurance', share: 58, tone: 'bg-brand' },
  { payer: 'Self pay', share: 27, tone: 'bg-teal' },
  { payer: 'Corporate schemes', share: 11, tone: 'bg-brand-bright' },
  { payer: 'Other', share: 4, tone: 'bg-edge-strong' },
];

// One registry drives every module. Appointments, invoices, claims, and the
// clinical queue all reference these people by name — nothing is invented locally.

// scope controls which roles see each metric: finance metrics stay out of clinical views.
// Values are derived from live state at render so the tiles always agree with the tables.
// `currency` is passed in rather than imported: the formatter is bound to the
// practice's configured billing currency, which this module has no way to know.
export const buildMetrics = ({ schedule, invoices, claims, patients, visitStatuses, currency }) => {
  const outstanding = invoices.filter((i) => i.status !== 'Paid').reduce((sum, i) => sum + i.amount, 0);
  const settled = claims.filter((c) => c.status === 'Adjudicated' || c.status === 'Remitted').length;
  const decided = claims.filter((c) => ['Adjudicated', 'Remitted', 'Rejected'].includes(c.status)).length;
  const completed = Object.values(visitStatuses).filter((s) => s === 'Completed').length;
  const noShows = Object.values(visitStatuses).filter((s) => s === 'No-show').length;
  const patientNames = new Set(patients.map((patient) => patient.name));
  const activeCarePlans = Object.entries(carePlansByPatient)
    .filter(([patientName]) => patientNames.has(patientName))
    .flatMap(([, plans]) => plans)
    .length;

  return [
    { label: 'Appointments today', value: String(schedule.length), delta: `${completed} completed, ${schedule.length - completed - noShows} remaining`, scope: 'all' },
    { label: 'Outstanding balance', value: currency(outstanding), delta: `${invoices.filter((i) => i.status !== 'Paid').length} open invoices`, scope: 'finance' },
    { label: 'No shows today', value: String(noShows), delta: noShows === 0 ? 'None so far' : 'Recall messages queued', scope: 'all' },
    { label: 'Claims settled', value: decided ? `${Math.round((settled / decided) * 100)}%` : 'Not recorded', delta: `${claims.filter((c) => c.status === 'Submitted').length} awaiting adjudication`, scope: 'finance' },
    { label: 'Patients in queue', value: String(schedule.length - completed - noShows), delta: `${patients.filter((p) => p.status === 'New').length} awaiting intake`, scope: 'clinical' },
    { label: 'Care plans active', value: String(activeCarePlans), delta: 'Across the registry', scope: 'clinical' },
  ];
};

export const tasks = [
  { title: 'Review lab results for 3 patients', meta: 'Clinical queue', time: '2h ago' },
  { title: 'Confirm postoperative follow up calls', meta: 'Operations', time: '45m ago' },
  { title: 'Authorise invoice batch for June', meta: 'Finance', time: '1h ago' },
];

// Invoice balances reconcile to each patient's balance in the registry above.

export const insightCards = [
  { title: 'Patient wait time', value: '12 min avg', detail: 'Steady this week', trend: '+2.1%' },
  { title: 'Follow ups due', value: '14', detail: '9 due in next 48h', trend: 'Low risk' },
  { title: 'Clinical notes', value: '96%', detail: 'Completed and signed', trend: 'On track' },
];
