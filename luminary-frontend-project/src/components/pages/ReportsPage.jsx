import React, { useMemo, useState } from 'react';
import {
  Activity,
  CalendarDays,
  CreditCard,
  Download,
  FileCheck2,
  MessageSquare,
  Search,
  Stethoscope,
  Users,
  X,
} from 'lucide-react';
import { carePlansByPatient } from '../../data/clinical';
import { claimStatusTone } from '../../data/billing';
import { patientStatusTone } from '../../data/registry';
import { visitStatusTone } from '../../data/clinical';
import { StatusPill } from '../shared/StatusPill';
import { EmptyState } from '../shared/EmptyState';
import { StickyBar } from '../ui';
import { useWorkspace } from '../../lib/workspace';

const REPORTS = [
  { id: 'overview', label: 'Overview', icon: Activity, detail: 'Whole-practice activity and risk.' },
  { id: 'financial', label: 'Financial', icon: CreditCard, detail: 'Invoices, aging, collections, and write-offs.' },
  { id: 'claims', label: 'Claims', icon: FileCheck2, detail: 'Claim lifecycle, rejections, and payer exposure.' },
  { id: 'clinical', label: 'Clinical', icon: Stethoscope, detail: 'Notes, diagnoses, and care plan coverage.' },
  { id: 'operations', label: 'Operations', icon: CalendarDays, detail: 'Schedule, queue, orders, and throughput.' },
  { id: 'patients', label: 'Patients', icon: Users, detail: 'Registry, balances, status, and cover.' },
  { id: 'communications', label: 'Comms', icon: MessageSquare, detail: 'Messages, delivery status, and audit activity.' },
];

const number = (value) => Number(value) || 0;
const percent = (value, total) => (total > 0 ? `${Math.round((value / total) * 100)}%` : '0%');
const text = (value) => String(value ?? '').toLowerCase();
const currencyFallback = (value) => `USD ${number(value).toFixed(2)}`;
const titleize = (value) => String(value).replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
const displayCopy = (value) => String(value ?? '').replace(/Self-pay/g, 'Self pay').replace(/No-show/g, 'No show');

function rowMatches(row, query) {
  if (!query) return true;
  return Object.values(row).some((value) => text(value).includes(query));
}

function groupCount(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || 'Unassigned';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topGroups(rows, key, limit = 5) {
  return Object.entries(groupCount(rows, key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function claimAmount(claim) {
  if (claim.amount) return claim.amount;
  return currencyFallback(claim.claimed ?? claim.claimedAmount);
}

function downloadExcelReport({ filename, title, metrics, columns, rows, highlights }) {
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const renderTable = (headers, dataRows) => `
    <table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
      <tbody>${dataRows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  `;
  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: Arial, sans-serif; }
          h1, h2 { color: #10233f; }
          table { border-collapse: collapse; margin-bottom: 20px; width: 100%; }
          th { background: #edf5ff; color: #40506a; font-weight: 700; }
          th, td { border: 1px solid #d8e2ef; padding: 8px; text-align: left; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(title)}</h1>
        <h2>Metrics</h2>
        ${renderTable(['Metric', 'Value', 'Detail'], metrics.map((metric) => [metric.label, metric.value, metric.detail]))}
        <h2>Rows</h2>
        ${renderTable(columns.map(titleize), rows.map((row) => columns.map((column) => row[column])))}
        <h2>Breakdown</h2>
        ${renderTable(['Group', 'Count'], highlights.map((item) => [item.label, item.value]))}
      </body>
    </html>
  `;
  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function activeCarePlansFor(patients) {
  const visiblePatients = new Set(patients.map((patient) => patient.name));
  return Object.entries(carePlansByPatient)
    .filter(([patient]) => visiblePatients.has(patient))
    .flatMap(([patient, plans]) => plans.map((plan) => ({ patient, ...plan })));
}

function buildReportData(workspace) {
  const {
    auditLog,
    currency,
    outstandingOn,
    daysOverdue,
    practicePatients,
    practiceSchedule,
    todaysSchedule,
    practiceInvoices,
    practiceClaims,
    practiceEncounters,
    practiceMessages,
    practiceQueue,
    practiceOrders,
    visitStatuses,
  } = workspace;

  const money = currency || currencyFallback;
  const invoices = practiceInvoices || [];
  const claims = practiceClaims || [];
  const patients = practicePatients || [];
  const encounters = practiceEncounters || [];
  const messages = practiceMessages || [];
  const orders = practiceOrders || [];
  const queue = practiceQueue || [];
  const schedule = practiceSchedule || [];
  const today = todaysSchedule || [];
  const audit = auditLog || [];
  const carePlans = activeCarePlansFor(patients);
  const openInvoices = invoices.filter((invoice) => invoice.status !== 'Paid');
  const outstanding = invoices.reduce((sum, invoice) => sum + number(outstandingOn ? outstandingOn(invoice) : invoice.amount), 0);
  const overdueInvoices = openInvoices.filter((invoice) => (daysOverdue ? daysOverdue(invoice) : 0) > 0);
  const rejectedClaims = claims.filter((claim) => claim.status === 'Rejected');
  const submittedClaims = claims.filter((claim) => ['Submitted', 'Acknowledged', 'Processing', 'Submitting'].includes(claim.status));
  const signedNotes = encounters.filter((note) => ['Signed', 'Amended'].includes(note.status));
  const completedVisits = Object.values(visitStatuses || {}).filter((status) => status === 'Completed').length;
  const noShows = Object.values(visitStatuses || {}).filter((status) => status === 'No-show').length;
  const completedOrders = orders.filter((order) => order.status === 'Completed');
  const unbilledOrders = completedOrders.filter((order) => !order.invoiceId);

  const overviewRows = [
    { area: 'Patients', metric: 'Registered patients', value: patients.length, risk: patients.filter((patient) => number(patient.balance) > 0).length, owner: 'Front desk' },
    { area: 'Schedule', metric: 'Appointments today', value: today.length, risk: noShows, owner: 'Reception' },
    { area: 'Clinical', metric: 'Signed note coverage', value: percent(signedNotes.length, encounters.length), risk: encounters.length - signedNotes.length, owner: 'Clinical team' },
    { area: 'Billing', metric: 'Outstanding balance', value: money(outstanding), risk: overdueInvoices.length, owner: 'Finance' },
    { area: 'Claims', metric: 'Claims awaiting payer', value: submittedClaims.length, risk: rejectedClaims.length, owner: 'Claims desk' },
    { area: 'Orders', metric: 'Completed unbilled orders', value: unbilledOrders.length, risk: unbilledOrders.length, owner: 'Billing engine' },
    { area: 'Communications', metric: 'Patient messages', value: messages.length, risk: messages.filter((message) => ['Pending', 'Failed'].includes(message.status)).length, owner: 'Comms' },
  ];

  const financialRows = invoices.map((invoice) => {
    const outstandingValue = outstandingOn ? outstandingOn(invoice) : invoice.amount;
    const overdueDays = daysOverdue ? daysOverdue(invoice) : 0;
    const paid = (invoice.payments || []).reduce((sum, payment) => sum + number(payment.amount), 0);
    const adjusted = (invoice.adjustments || []).reduce((sum, adjustment) => sum + number(adjustment.amount), 0);
    return {
      invoice: invoice.id,
      patient: invoice.patient,
      issued: invoice.date || invoice.issuedOn,
      due: invoice.dueDate || invoice.dueOn,
      status: invoice.status,
      payer: displayCopy(invoice.insurance || 'Self pay'),
      billed: money(invoice.amount),
      paid: money(paid),
      adjusted: money(adjusted),
      outstanding: money(outstandingValue),
      overdue: overdueDays > 0 ? `${overdueDays} days` : 'Current',
    };
  });

  const claimRows = claims.map((claim) => ({
    claim: claim.id,
    patient: claim.patient,
    member: displayCopy(claim.memberNo || 'Missing'),
    payer: claim.plan || claim.payerName || 'No payer',
    invoice: claim.invoice || 'No invoice',
    status: claim.status,
    serviceDate: claim.serviceDate || claim.createdAt || 'Missing',
    provider: claim.provider || 'Unassigned',
    amount: claimAmount(claim),
    diagnosis: claim.icd10 || 'Not coded',
    blockers: claim.validation?.errors?.length ?? (claim.icd10 === 'Not coded' ? 1 : 0),
  }));

  const clinicalRows = [
    ...encounters.map((note) => ({
      type: 'Encounter note',
      patient: note.patientName,
      provider: note.provider,
      date: note.date || note.signedAt || 'No date',
      status: note.status,
      detail: note.type,
      followUp: note.followUp || 'None recorded',
    })),
    ...carePlans.map((plan) => ({
      type: 'Care plan',
      patient: plan.patient,
      provider: 'Care team',
      date: plan.startDate,
      status: plan.status,
      detail: plan.name,
      followUp: plan.nextReview || 'No review date',
    })),
  ];

  const operationsRows = [
    ...schedule.map((appointment) => ({
      type: 'Appointment',
      id: appointment.id,
      patient: appointment.patient,
      owner: appointment.provider,
      time: appointment.time,
      status: visitStatuses?.[appointment.patient] || 'Booked',
      detail: `${appointment.type}, ${appointment.room || appointment.mode || 'No room'}`,
    })),
    ...queue.map((item) => ({
      type: 'Queue',
      id: item.id || item.patient,
      patient: item.patient,
      owner: item.provider || 'Front desk',
      time: item.time || item.arrivedAt || 'Now',
      status: item.status || 'Waiting',
      detail: item.reason || item.type || 'Clinical queue',
    })),
    ...orders.map((order) => ({
      type: 'Order',
      id: order.id,
      patient: order.patientName,
      owner: order.orderedBy,
      time: order.orderedAt,
      status: order.status,
      detail: `${order.serviceName}, ${order.department}`,
    })),
  ];

  const patientRows = patients.map((patient) => ({
    patient: patient.name,
    patientId: patient.id,
    status: patient.status,
    next: patient.next,
    balance: money(patient.balance),
    member: displayCopy(patient.memberNo || 'Self pay'),
    invoices: invoices.filter((invoice) => invoice.patient === patient.name).length,
    claims: claims.filter((claim) => claim.patient === patient.name).length,
    carePlans: carePlans.filter((plan) => plan.patient === patient.name).length,
  }));

  const communicationRows = [
    ...messages.map((message) => ({
      type: 'Patient message',
      subject: message.patient,
      channel: message.channel,
      status: message.status,
      time: message.time,
      detail: message.type,
      owner: 'Communications',
    })),
    ...audit.slice(0, 20).map((entry) => ({
      type: 'Audit',
      subject: entry.subject,
      channel: entry.severity || 'Audit',
      status: entry.action,
      time: entry.time,
      detail: entry.detail || entry.user || 'Activity',
      owner: entry.user || 'System',
    })),
  ];

  return {
    overview: {
      metrics: [
        { label: 'Patients', value: patients.length, detail: 'Visible registry records', tone: 'accent' },
        { label: 'Today', value: today.length, detail: `${completedVisits} completed, ${noShows} no shows`, tone: noShows ? 'warm' : 'success' },
        { label: 'Outstanding', value: money(outstanding), detail: `${openInvoices.length} open invoices`, tone: overdueInvoices.length ? 'alert' : 'success' },
        { label: 'Claims risk', value: rejectedClaims.length, detail: `${submittedClaims.length} awaiting payer`, tone: rejectedClaims.length ? 'alert' : 'accent' },
      ],
      columns: ['area', 'metric', 'value', 'risk', 'owner'],
      rows: overviewRows,
      statusKey: null,
      highlights: topGroups(claimRows, 'status', 4),
    },
    financial: {
      metrics: [
        { label: 'Billed', value: money(invoices.reduce((sum, invoice) => sum + number(invoice.amount), 0)), detail: `${invoices.length} invoices`, tone: 'accent' },
        { label: 'Outstanding', value: money(outstanding), detail: `${openInvoices.length} open`, tone: outstanding ? 'warm' : 'success' },
        { label: 'Overdue', value: overdueInvoices.length, detail: 'Invoices past due', tone: overdueInvoices.length ? 'alert' : 'success' },
        { label: 'Paid invoices', value: invoices.filter((invoice) => invoice.status === 'Paid').length, detail: 'Settled in full', tone: 'success' },
      ],
      columns: ['invoice', 'patient', 'status', 'payer', 'billed', 'paid', 'adjusted', 'outstanding', 'overdue'],
      rows: financialRows,
      statusKey: 'status',
      highlights: topGroups(financialRows, 'payer', 4),
    },
    claims: {
      metrics: [
        { label: 'Claims', value: claims.length, detail: 'Total visible claims', tone: 'accent' },
        { label: 'Submitted', value: submittedClaims.length, detail: 'Awaiting response', tone: 'warm' },
        { label: 'Rejected', value: rejectedClaims.length, detail: 'Needs resolution', tone: rejectedClaims.length ? 'alert' : 'success' },
        { label: 'Clean coding', value: percent(claimRows.filter((row) => row.diagnosis !== 'Not coded').length, claimRows.length), detail: 'Diagnosis present', tone: 'success' },
      ],
      columns: ['claim', 'patient', 'payer', 'invoice', 'status', 'provider', 'amount', 'diagnosis', 'blockers'],
      rows: claimRows,
      statusKey: 'status',
      highlights: topGroups(claimRows, 'payer', 4),
    },
    clinical: {
      metrics: [
        { label: 'Notes', value: encounters.length, detail: `${signedNotes.length} signed or amended`, tone: 'accent' },
        { label: 'Care plans', value: carePlans.length, detail: 'Active patient plans', tone: 'success' },
        { label: 'Draft notes', value: encounters.filter((note) => note.status === 'Draft').length, detail: 'Require signing', tone: encounters.some((note) => note.status === 'Draft') ? 'warm' : 'success' },
        { label: 'Follow ups', value: clinicalRows.filter((row) => row.followUp && row.followUp !== 'None recorded').length, detail: 'Documented next steps', tone: 'accent' },
      ],
      columns: ['type', 'patient', 'provider', 'date', 'status', 'detail', 'followUp'],
      rows: clinicalRows,
      statusKey: 'status',
      highlights: topGroups(clinicalRows, 'provider', 4),
    },
    operations: {
      metrics: [
        { label: 'Appointments', value: schedule.length, detail: `${today.length} today`, tone: 'accent' },
        { label: 'Queue', value: queue.length, detail: 'Patients in workflow', tone: queue.length ? 'warm' : 'success' },
        { label: 'Orders', value: orders.length, detail: `${completedOrders.length} completed`, tone: 'accent' },
        { label: 'Unbilled orders', value: unbilledOrders.length, detail: 'Completed without invoice', tone: unbilledOrders.length ? 'alert' : 'success' },
      ],
      columns: ['type', 'id', 'patient', 'owner', 'time', 'status', 'detail'],
      rows: operationsRows,
      statusKey: 'status',
      highlights: topGroups(operationsRows, 'type', 4),
    },
    patients: {
      metrics: [
        { label: 'Patients', value: patients.length, detail: 'Visible registry', tone: 'accent' },
        { label: 'New patients', value: patients.filter((patient) => patient.status === 'New').length, detail: 'Awaiting intake', tone: 'warm' },
        { label: 'With balances', value: patients.filter((patient) => number(patient.balance) > 0).length, detail: 'Financial follow up', tone: 'alert' },
        { label: 'Care plans', value: carePlans.length, detail: 'Across registry', tone: 'success' },
      ],
      columns: ['patient', 'patientId', 'status', 'next', 'balance', 'member', 'invoices', 'claims', 'carePlans'],
      rows: patientRows,
      statusKey: 'status',
      highlights: topGroups(patientRows, 'status', 4),
    },
    communications: {
      metrics: [
        { label: 'Messages', value: messages.length, detail: 'Patient communications', tone: 'accent' },
        { label: 'Delivered', value: messages.filter((message) => ['Delivered', 'Confirmed'].includes(message.status)).length, detail: 'Successful sends', tone: 'success' },
        { label: 'Pending', value: messages.filter((message) => message.status === 'Pending').length, detail: 'Needs follow up', tone: messages.some((message) => message.status === 'Pending') ? 'warm' : 'success' },
        { label: 'Audit events', value: audit.length, detail: 'Recent workspace activity', tone: 'neutral' },
      ],
      columns: ['type', 'subject', 'channel', 'status', 'time', 'detail', 'owner'],
      rows: communicationRows,
      statusKey: 'status',
      highlights: topGroups(communicationRows, 'channel', 4),
    },
  };
}

function toneForStatus(reportId, status) {
  if (reportId === 'claims') return claimStatusTone[status] || 'neutral';
  if (reportId === 'patients') return patientStatusTone[status] || 'neutral';
  if (reportId === 'operations') return visitStatusTone[status] || (['Completed', 'Delivered', 'Confirmed'].includes(status) ? 'success' : 'neutral');
  if (['Paid', 'Delivered', 'Confirmed', 'Signed', 'Amended', 'Active'].includes(status)) return 'success';
  if (['Overdue', 'Rejected', 'Failed', 'Cancelled', 'Declined'].includes(status)) return 'alert';
  if (['Pending', 'Submitted', 'Processing', 'Draft', 'Ordered', 'In progress'].includes(status)) return 'warm';
  return 'neutral';
}

export default function ReportsPage() {
  const workspace = useWorkspace();
  const { access, notify } = workspace;
  const [activeReport, setActiveReport] = useState('overview');
  const [query, setQuery] = useState('');

  const reports = useMemo(() => buildReportData(workspace), [workspace]);
  const definition = REPORTS.find((report) => report.id === activeReport) || REPORTS[0];
  const report = reports[definition.id] || reports.overview;
  const normalizedQuery = query.trim().toLowerCase();
  const rows = useMemo(
    () => report.rows.filter((row) => rowMatches(row, normalizedQuery)),
    [normalizedQuery, report.rows]
  );

  const exportCurrentReport = () => {
    const filename = `report-${definition.id}.xls`;
    downloadExcelReport({
      filename,
      title: `${definition.label} report`,
      metrics: report.metrics,
      columns: report.columns,
      rows,
      highlights: report.highlights,
    });
    notify(`${filename} downloaded`);
  };

  return (
    <div className="lh-has-sticky-bar space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="lh-page-kicker">Reports</p>
          <h1 className="lh-page-title">Practice reports</h1>
          <p className="lh-page-subtitle">Build focused reports from the data already visible in this workspace.</p>
        </div>
        {access.can.exportReports && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={exportCurrentReport} className="lh-secondary-button">
              <Download size={14} />Download Excel
            </button>
          </div>
        )}
      </div>

      <ReportNav activeReport={activeReport} reports={reports} onSelect={setActiveReport} />

      <section className="lh-card-pad space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <definition.icon size={17} className="text-brand" />
              <p className="text-sm font-semibold text-ink">{definition.label}</p>
            </div>
            <p className="mt-1 text-xs text-body">{definition.detail}</p>
          </div>
          <label className="relative block w-full lg:max-w-sm">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this report"
              className="h-10 w-full rounded-lg border border-line bg-white pl-9 pr-10 text-sm text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
            />
            {query ? (
              <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted transition hover:bg-line hover:text-ink" aria-label="Clear search">
                <X size={15} />
              </button>
            ) : null}
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          {report.metrics.map((metric) => (
            <MetricCard key={metric.label} {...metric} />
          ))}
        </div>
      </section>

      <div className="grid min-w-0 items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
        <ReportTable reportId={definition.id} columns={report.columns} rows={rows} statusKey={report.statusKey} />
        <ReportHighlights title={`${definition.label} breakdown`} highlights={report.highlights} rowCount={rows.length} />
      </div>
    </div>
  );
}

function ReportNav({ activeReport, reports, onSelect }) {
  return (
    <StickyBar label="Reports">
    <nav className="flex gap-1 overflow-x-auto">
      {REPORTS.map((report) => {
        const active = activeReport === report.id;
        const Icon = report.icon;
        const count = reports[report.id]?.rows.length ?? 0;
        return (
          <button
            key={report.id}
            type="button"
            title={report.detail}
            onClick={() => onSelect(report.id)}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex h-control-sm shrink-0 items-center gap-2 rounded-sm px-3 text-small font-medium transition duration-fast ${active ? 'bg-brand/[0.08] text-brand-deep shadow-nav-active' : 'text-body hover:bg-ink/[0.04] hover:text-ink'}`}
          >
            <Icon size={16} strokeWidth={1.8} />
            <span>{report.label}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-xs leading-none tnum ${active ? 'bg-brand/10 text-brand-deep' : 'bg-ink/[0.05] text-muted'}`}>{count}</span>
          </button>
        );
      })}
    </nav>
    </StickyBar>
  );
}

function MetricCard({ label, value, detail, tone }) {
  const tones = {
    neutral: 'bg-edge-strong',
    warm: 'bg-warning-bright',
    accent: 'bg-brand-bright',
    success: 'bg-success-bright',
    alert: 'bg-danger-bright',
  };

  // Tone is a small dot beside the label rather than a painted tile.
  return (
    <div className="lh-metric min-w-0">
      <p className="flex items-center gap-2 text-small font-medium text-muted">
        <span className={`h-2 w-2 shrink-0 rounded-full ${tones[tone] || tones.neutral}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-2 truncate text-heading font-semibold tracking-title text-ink tnum">{value}</p>
      <p className="mt-1 truncate text-caption text-muted">{detail}</p>
    </div>
  );
}

function ReportTable({ reportId, columns, rows, statusKey }) {
  if (!rows.length) {
    return <EmptyState title="No rows match this report" detail="Clear the search field or choose another report type." />;
  }

  return (
    <div className="lh-table-shell">
      <table className="min-w-full text-left text-sm">
        <thead className="lh-table-head">
          <tr>
            {columns.map((column) => (
              <th key={column} className="whitespace-nowrap px-4 py-3 font-medium text-caption">
                {titleize(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${reportId}-${index}`} className="border-t border-line bg-white transition hover:bg-surface">
              {columns.map((column) => (
                <td key={column} className="max-w-[260px] truncate px-4 py-3 text-body">
                  {column === statusKey ? (
                    <StatusPill label={row[column]} tone={toneForStatus(reportId, row[column])} />
                  ) : (
                    <span className={index === 0 && column === columns[0] ? 'font-medium text-ink' : ''}>{row[column]}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportHighlights({ title, highlights, rowCount }) {
  const max = Math.max(...highlights.map((item) => item.value), 1);

  return (
    <aside className="lh-card-pad lh-side-panel">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-caption font-medium text-muted">Breakdown</p>
          <h2 className="mt-2 text-lg font-semibold tracking-heading text-ink">{title}</h2>
        </div>
        <StatusPill label={`${rowCount} rows`} tone="neutral" />
      </div>
      <div className="mt-5 space-y-4">
        {highlights.length ? highlights.map((item) => (
          <div key={item.label}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
              <span className="truncate font-medium text-ink">{item.label}</span>
              <span className="text-body">{item.value}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(8, (item.value / max) * 100)}%` }} />
            </div>
          </div>
        )) : (
          <p className="text-sm text-body">No grouped data yet.</p>
        )}
      </div>
    </aside>
  );
}
