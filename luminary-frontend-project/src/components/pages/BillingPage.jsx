import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  FileText,
  Plus,
  Printer,
  Receipt,
  Scissors,
  Search,
} from 'lucide-react';
import { StatusPill } from '../shared/StatusPill';
import { EmptyState } from '../shared/EmptyState';
import { Modal } from '../ui';
import { useWorkspace } from '../../lib/workspace';
import {
  methodLabel,
  paidSoFar,
  adjustedTotal,
  adjustmentLabel,
  buildAging,
  agingBucket,
  daysOverdue,
  AGING_BUCKETS,
  summariseLines,
  isAdjudicated,
  balanceAfter,
  statementFor,
} from '../../lib/money';
import { claimStatusTone } from '../../data/billing';

const BILLING_TABS = ['Overview', 'Accounts', 'Statements', 'Invoices', 'Claims exposure', 'Receipts'];
const STATEMENT_RANGES = [
  { key: 'today', label: 'Today' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: 'open', label: 'All open balances' },
  { key: 'all', label: 'All history' },
];
const BILLING_RANGES = [...STATEMENT_RANGES, { key: 'custom', label: 'Custom' }];

const parseDate = (value) => {
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

const invoiceDate = (invoice) => parseDate(invoice.issuedOn) || parseDate(invoice.date);
const paymentDate = (payment) => parseDate(payment.receivedAt);
const adjustmentDate = (adjustment) => parseDate(adjustment.at);
const searchable = (...values) => values.map((value) => String(value ?? '').toLowerCase()).join(' ');
const matchesQuery = (query, ...values) => !query.trim() || searchable(...values).includes(query.trim().toLowerCase());
const dateOnly = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
};
const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
const endOfDay = (value) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
};
const billingRangeBounds = (range, today, customFrom, customTo) => {
  if (range === 'all' || range === 'open') return true;
  if (range === 'custom') {
    return {
      from: customFrom ? startOfDay(customFrom) : 0,
      to: customTo ? endOfDay(customTo) : Number.POSITIVE_INFINITY,
    };
  }
  const start = new Date(today);
  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - Number(range));
    start.setHours(0, 0, 0, 0);
  }
  return { from: start.getTime(), to: Number.POSITIVE_INFINITY };
};
const timeInBounds = (time, bounds) => {
  if (bounds === true) return true;
  if (!time) return false;
  return time >= bounds.from && time <= bounds.to;
};
const invoiceInBillingRange = (invoice, range, bounds, outstandingOn) => {
  if (range === 'all') return true;
  if (range === 'open') {
    return outstandingOn(invoice) > 0 || summariseLines(invoice.services || []).outstandingFunder > 0;
  }
  return timeInBounds(invoiceDate(invoice), bounds);
};
const paymentInBillingRange = (payment, range, bounds, outstandingOn) => {
  if (range === 'all') return true;
  if (range === 'open') return payment.invoice ? invoiceInBillingRange(payment.invoice, range, bounds, outstandingOn) : false;
  return timeInBounds(paymentDate(payment), bounds);
};
const rowInStatementRange = (row, range, today, customFrom, customTo) => {
  const bounds = billingRangeBounds(range, today, customFrom, customTo);
  if (bounds === true) return true;
  const rowTime = Number(row.sort || parseDate(row.date));
  return timeInBounds(rowTime, bounds);
};

function buildPatientLedger(patient, invoices, formatMoney) {
  const statement = statementFor(patient, invoices, new Date());
  const rows = [];

  statement.invoices.forEach((invoice) => {
    const currency = invoice.currency || statement.currency;
    rows.push({
      date: invoice.issuedOn || invoice.date || 'Undated',
      sort: invoiceDate(invoice),
      type: 'Invoice',
      ref: invoice.id,
      detail: invoice.services?.map((line) => line.desc).filter(Boolean).join(', ') || invoice.insurance || 'Invoice raised',
      debit: Number(invoice.patientResponsibility ?? 0),
      credit: 0,
      currency,
      claimStatus: invoice.claimStatus,
    });

    (invoice.payments || []).forEach((payment) => {
      rows.push({
        date: payment.receivedAt || 'Undated',
        sort: paymentDate(payment),
        type: payment.amount < 0 ? 'Reversal' : 'Payment',
        ref: payment.id,
        detail: `${methodLabel(payment.method)} against ${invoice.id}`,
        debit: payment.amount < 0 ? Math.abs(Number(payment.amount || 0)) : 0,
        credit: payment.amount > 0 ? Number(payment.amount || 0) * Number(payment.fxRate || 1) : 0,
        currency,
      });
    });

    (invoice.adjustments || []).forEach((adjustment) => {
      rows.push({
        date: adjustment.at || 'Undated',
        sort: adjustmentDate(adjustment),
        type: adjustmentLabel(adjustment.type),
        ref: adjustment.id,
        detail: adjustment.reason || `Applied to ${invoice.id}`,
        debit: 0,
        credit: Number(adjustment.amount || 0),
        currency,
      });
    });
  });

  let balance = 0;
  const ledger = rows
    .sort((a, b) => a.sort - b.sort || String(a.ref).localeCompare(String(b.ref)))
    .map((row) => {
      balance = Math.max(0, Math.round((balance + row.debit - row.credit) * 100) / 100);
      return { ...row, balance, formattedBalance: formatMoney(balance, row.currency) };
    });

  return { ...statement, ledger };
}

export default function BillingPage() {
  const {
    access,
    openDialog,
    exportCsv,
    practiceInvoices,
    practiceClaims,
    selectedInvoice,
    setSelectedInvoice,
    currency,
    receipt,
    setReceipt,
    outstandingOn,
    formatMoney,
    openStatement,
    printReceipt,
    reprintReceipt,
    billingCurrency,
  } = useWorkspace();

  const [activeTab, setActiveTab] = useState('Overview');
  const [accountPatient, setAccountPatient] = useState('');
  const [billingRange, setBillingRange] = useState('all');
  const [customFrom, setCustomFrom] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return dateOnly(date);
  });
  const [customTo, setCustomTo] = useState(() => dateOnly(new Date()));
  const [overviewQuery, setOverviewQuery] = useState('');
  const [accountsQuery, setAccountsQuery] = useState('');
  const [statementsQuery, setStatementsQuery] = useState('');
  const [statementPatient, setStatementPatient] = useState('');
  const [invoicesQuery, setInvoicesQuery] = useState('');
  const [claimsQuery, setClaimsQuery] = useState('');
  const [receiptsQuery, setReceiptsQuery] = useState('');
  const [invoiceModal, setInvoiceModal] = useState(null);
  const [receiptModal, setReceiptModal] = useState(null);
  const today = useMemo(() => new Date(), []);
  const rangeBounds = useMemo(() => billingRangeBounds(billingRange, today, customFrom, customTo), [billingRange, today, customFrom, customTo]);
  const billingInvoices = useMemo(
    () => practiceInvoices.filter((invoice) => invoiceInBillingRange(invoice, billingRange, rangeBounds, outstandingOn)),
    [billingRange, outstandingOn, practiceInvoices, rangeBounds]
  );

  const accounts = useMemo(() => {
    const names = [...new Set(billingInvoices.map((invoice) => invoice.patient))].sort();
    return names.map((patient) => {
      const invoices = billingInvoices.filter((invoice) => invoice.patient === patient);
      const statement = statementFor(patient, billingInvoices, today);
      const insurerExposure = invoices.reduce((sum, invoice) => sum + summariseLines(invoice.services || []).outstandingFunder, 0);
      const lastInvoice = [...invoices].sort((a, b) => invoiceDate(b) - invoiceDate(a))[0];
      return { patient, invoices, statement, insurerExposure, lastInvoice };
    });
  }, [billingInvoices, today]);

  const filteredAccounts = accounts.filter((account) =>
    matchesQuery(accountsQuery, account.patient, account.lastInvoice?.id, account.statement.outstanding, account.insurerExposure)
  );

  const account = accountPatient
    ? accounts.find((item) => item.patient === accountPatient) || null
    : null;
  const accountClaims = account ? practiceClaims.filter((claim) => claim.patient === account.patient && account.invoices.some((invoice) => invoice.claim === claim.id)) : [];
  const accountStatement = account ? buildPatientLedger(account.patient, billingInvoices, formatMoney) : null;

  const totals = useMemo(() => {
    const gross = billingInvoices.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
    const patientOutstanding = billingInvoices.reduce((sum, invoice) => sum + outstandingOn(invoice), 0);
    const collected = billingInvoices.reduce((sum, invoice) => sum + paidSoFar(invoice.payments), 0);
    const writtenOff = billingInvoices.reduce((sum, invoice) => sum + adjustedTotal(invoice.adjustments), 0);
    const insurerOutstanding = billingInvoices.reduce((sum, invoice) => sum + summariseLines(invoice.services || []).outstandingFunder, 0);
    return { gross, patientOutstanding, collected, writtenOff, insurerOutstanding };
  }, [billingInvoices, outstandingOn]);

  const aging = buildAging(billingInvoices, today);
  const rangeSelectedInvoice = billingInvoices.find((invoice) => invoice.id === selectedInvoice?.id) || null;
  const selectedInvoiceCurrency = rangeSelectedInvoice?.currency ?? billingCurrency;
  const selectedInvoiceOutstanding = rangeSelectedInvoice ? outstandingOn(rangeSelectedInvoice) : 0;
  const selectedInvoiceDays = rangeSelectedInvoice ? daysOverdue(rangeSelectedInvoice, today) : 0;
  const claimForInvoice = (invoice) => practiceClaims.find((claim) => claim.id === invoice?.claim) || null;

  const openAccount = (patient) => {
    setAccountPatient(patient);
    setActiveTab('Accounts');
  };

  const openInvoice = (invoice) => {
    setSelectedInvoice(invoice);
    setInvoiceModal(invoice);
  };

  const openPatientStatement = (patient) => {
    setStatementPatient(patient);
    setActiveTab('Statements');
  };

  const openReceipt = (payment) => {
    setReceiptModal(payment);
  };

  const printReceiptFromModal = (payment) => {
    if (!payment || !reprintReceipt) return;
    reprintReceipt(payment.invoice, payment);
  };

  const printInvoice = (invoice) => {
    setInvoiceModal(invoice);
    const done = () => document.body.classList.remove('lh-printing-invoice');
    window.addEventListener('afterprint', done, { once: true });
    document.body.classList.add('lh-printing-invoice');
    try {
      window.print();
    } finally {
      done();
    }
  };

  const takePayment = (invoice) =>
    openDialog('payment', {
      invoiceId: invoice.id,
      patient: invoice.patient,
      invoiceCurrency: invoice.currency ?? billingCurrency,
      outstanding: outstandingOn(invoice),
      currency: invoice.currency ?? billingCurrency,
      method: 'cash',
    });

  const takeAdjustment = (invoice) =>
    openDialog('adjustment', {
      invoiceId: invoice.id,
      patient: invoice.patient,
      invoiceCurrency: invoice.currency ?? billingCurrency,
      outstanding: outstandingOn(invoice),
      days: daysOverdue(invoice, today),
      adjustmentType: 'write_off',
    });

  if (practiceInvoices.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader openDialog={openDialog} canCreate={access.can.createInvoice} />
        <EmptyState
          title="No invoices yet"
          detail="Nothing has been billed in this practice. Raise an invoice and it will appear here with its claim, ledger and aging."
          action={access.can.createInvoice && (
            <button type="button" onClick={() => openDialog('invoice')} className="lh-primary-button">
              <Plus size={14} /> New invoice
            </button>
          )}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader openDialog={openDialog} canCreate={access.can.createInvoice} />

      <nav className="flex gap-2 overflow-x-auto rounded-lg border border-line bg-white/90 p-1">
        {BILLING_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`shrink-0 rounded-md px-3 py-2 text-sm font-semibold transition ${activeTab === tab ? 'bg-ink text-white shadow-sm' : 'text-body hover:bg-line hover:text-ink'}`}
          >
            {tab}
          </button>
        ))}
      </nav>

      <BillingRangeBar
        range={billingRange}
        setRange={setBillingRange}
        customFrom={customFrom}
        setCustomFrom={setCustomFrom}
        customTo={customTo}
        setCustomTo={setCustomTo}
        shown={billingInvoices.length}
        total={practiceInvoices.length}
      />

      {activeTab === 'Overview' && (
        <OverviewView
          totals={totals}
          aging={aging}
          accounts={accounts}
          currency={currency}
          formatMoney={formatMoney}
          openAccount={openAccount}
          exportCsv={exportCsv}
          practiceInvoices={billingInvoices}
          billingCurrency={billingCurrency}
          today={today}
          outstandingOn={outstandingOn}
          query={overviewQuery}
          setQuery={setOverviewQuery}
        />
      )}

      {activeTab === 'Accounts' && !account && (
        <AccountsView
          accounts={filteredAccounts}
          query={accountsQuery}
          setQuery={setAccountsQuery}
          openAccount={openAccount}
          formatMoney={formatMoney}
        />
      )}

      {activeTab === 'Accounts' && account && (
        <PatientAccountView
          account={account}
          statement={accountStatement}
          claims={accountClaims}
          onBack={() => setAccountPatient('')}
          openInvoice={openInvoice}
          openPatientStatement={openPatientStatement}
          takePayment={takePayment}
          takeAdjustment={takeAdjustment}
          openStatement={openStatement}
          reprintReceipt={reprintReceipt}
          openReceipt={openReceipt}
          can={access.can}
          currency={currency}
          formatMoney={formatMoney}
          outstandingOn={outstandingOn}
        />
      )}

      {activeTab === 'Statements' && (
        <StatementsView
          accounts={accounts}
          selectedPatient={statementPatient}
          setSelectedPatient={setStatementPatient}
          query={statementsQuery}
          setQuery={setStatementsQuery}
          range={billingRange}
          customFrom={customFrom}
          customTo={customTo}
          practiceInvoices={practiceInvoices}
          formatMoney={formatMoney}
          currency={currency}
          outstandingOn={outstandingOn}
          today={today}
        />
      )}

      {activeTab === 'Invoices' && (
        <InvoicesView
          invoices={billingInvoices}
          selectedInvoice={rangeSelectedInvoice}
          openInvoice={openInvoice}
          takePayment={takePayment}
          takeAdjustment={takeAdjustment}
          can={access.can}
          currency={currency}
          formatMoney={formatMoney}
          outstandingOn={outstandingOn}
          selectedInvoiceCurrency={selectedInvoiceCurrency}
          selectedInvoiceOutstanding={selectedInvoiceOutstanding}
          selectedInvoiceDays={selectedInvoiceDays}
          query={invoicesQuery}
          setQuery={setInvoicesQuery}
          openReceipt={openReceipt}
          claimForInvoice={claimForInvoice}
        />
      )}

      {activeTab === 'Claims exposure' && (
        <ClaimsExposureView
          invoices={billingInvoices}
          claims={practiceClaims}
          currency={currency}
          openAccount={openAccount}
          query={claimsQuery}
          setQuery={setClaimsQuery}
        />
      )}

      {activeTab === 'Receipts' && (
        <ReceiptsView invoices={practiceInvoices} reprintReceipt={reprintReceipt} openReceipt={openReceipt} formatMoney={formatMoney} query={receiptsQuery} setQuery={setReceiptsQuery} range={billingRange} rangeBounds={rangeBounds} outstandingOn={outstandingOn} />
      )}

      {receipt && (
        <ReceiptBanner receipt={receipt} setReceipt={setReceipt} printReceipt={printReceipt} formatMoney={formatMoney} />
      )}

      <InvoiceModal
        invoice={invoiceModal}
        onClose={() => setInvoiceModal(null)}
        takePayment={takePayment}
        takeAdjustment={takeAdjustment}
        can={access.can}
        currency={currency}
        formatMoney={formatMoney}
        outstanding={invoiceModal ? outstandingOn(invoiceModal) : 0}
        days={invoiceModal ? daysOverdue(invoiceModal, today) : 0}
        onPrint={printInvoice}
        openReceipt={openReceipt}
        claim={claimForInvoice(invoiceModal)}
      />
      <ReceiptModal
        payment={receiptModal}
        onClose={() => setReceiptModal(null)}
        onPrint={printReceiptFromModal}
        formatMoney={formatMoney}
      />
      <InvoicePrintDocument invoice={invoiceModal} claim={claimForInvoice(invoiceModal)} formatMoney={formatMoney} />
    </div>
  );
}

function PageHeader({ openDialog, canCreate }) {
  return (
    <div className="lh-page-hero flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div>
        <h1 className="lh-page-title">Billing</h1>
        <p className="lh-page-subtitle">Practice finance, patient accounts, invoices, insurer exposure, and receipts.</p>
      </div>
      {canCreate && (
        <button type="button" onClick={() => openDialog('invoice')} className="lh-primary-button self-start">
          <Plus size={14} /> New invoice
        </button>
      )}
    </div>
  );
}

function Metric({ label, value, detail, tone = 'neutral' }) {
  const tones = {
    neutral: 'border-line bg-white',
    accent: 'border-teal/20 bg-teal-soft',
    success: 'border-success/20 bg-success-soft',
    warm: 'border-warning/20 bg-warning-wash',
    alert: 'border-danger/20 bg-danger-soft',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone] || tones.neutral}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-2 text-xl font-semibold tracking-[-0.02em] text-ink tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-body">{detail}</p>
    </div>
  );
}

function SectionSearch({ value, onChange, placeholder }) {
  return (
    <label className="relative block w-full md:w-80">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-lg border border-line bg-white pl-9 pr-3 text-sm text-ink outline-none transition focus:border-teal focus:ring-2 focus:ring-teal-soft"
      />
    </label>
  );
}

function BillingRangeBar({ range, setRange, customFrom, setCustomFrom, customTo, setCustomTo, shown, total }) {
  return (
    <section className="rounded-lg border border-line bg-white/90 p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Billing range</p>
          <p className="mt-1 text-sm text-body">{shown} of {total} invoice record{total === 1 ? '' : 's'} in the current invoice-based view.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {BILLING_RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setRange(option.key)}
              className={`rounded-md border px-3 py-2 text-xs font-semibold transition ${range === option.key ? 'border-ink bg-ink text-white' : 'border-line bg-white text-body hover:border-brand-edge hover:text-brand'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {range === 'custom' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 md:w-[420px]">
          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">
            From
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm font-medium normal-case tracking-normal text-ink outline-none focus:border-teal focus:ring-2 focus:ring-teal-soft"
            />
          </label>
          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">
            To
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm font-medium normal-case tracking-normal text-ink outline-none focus:border-teal focus:ring-2 focus:ring-teal-soft"
            />
          </label>
        </div>
      )}
    </section>
  );
}

function OverviewView({ totals, aging, accounts, currency, formatMoney, openAccount, exportCsv, practiceInvoices, billingCurrency, today, outstandingOn, query, setQuery }) {
  const overdueAccounts = accounts
    .filter((account) => account.statement.outstanding > 0)
    .filter((account) => matchesQuery(query, account.patient, account.lastInvoice?.id, account.statement.oldestDays, account.statement.outstanding))
    .sort((a, b) => b.statement.oldestDays - a.statement.oldestDays || b.statement.outstanding - a.statement.outstanding)
    .slice(0, 6);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-5">
        <Metric label="Billed" value={currency(totals.gross)} detail="Gross invoice value" />
        <Metric label="Patient AR" value={currency(totals.patientOutstanding)} detail="Collectable patient balances" tone={totals.patientOutstanding > 0 ? 'warm' : 'success'} />
        <Metric label="Collected" value={currency(totals.collected)} detail="Receipted payments" tone="success" />
        <Metric label="Insurer exposure" value={currency(totals.insurerOutstanding)} detail="Approved not yet remitted" tone="accent" />
        <Metric label="Written off" value={currency(totals.writtenOff)} detail="Credits and write-offs" tone={totals.writtenOff > 0 ? 'alert' : 'neutral'} />
      </div>

      <section className="lh-card-pad">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Accounts receivable</h2>
            <p className="mt-1 text-sm text-body">
              {aging.overdue > 0 ? `${formatMoney(aging.overdue)} of ${formatMoney(aging.total)} is past due.` : 'Nothing is past due.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => exportCsv('accounts-receivable.csv', [
              { label: 'Invoice', get: (r) => r.id },
              { label: 'Patient', get: (r) => r.patient },
              { label: 'Issued', get: (r) => r.date },
              { label: 'Due', get: (r) => r.dueDate },
              { label: `Amount ${billingCurrency}`, get: (r) => r.amount },
              { label: 'Collected', get: (r) => paidSoFar(r.payments) },
              { label: 'Outstanding', get: (r) => outstandingOn(r) },
              { label: 'Written off', get: (r) => adjustedTotal(r.adjustments) },
              { label: 'Days overdue', get: (r) => Math.max(0, daysOverdue(r, today) ?? 0) },
              { label: 'Aging bucket', get: (r) => (outstandingOn(r) > 0 ? AGING_BUCKETS.find((b) => b.key === agingBucket(daysOverdue(r, today)))?.label : 'Settled') },
              { label: 'Status', get: (r) => r.status },
              { label: 'Claim status', get: (r) => r.claimStatus },
            ], practiceInvoices)}
            className="lh-secondary-button"
          >
            <FileText size={14} /> Export
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {aging.buckets.map((bucket) => {
            const share = aging.total > 0 ? (bucket.outstanding / aging.total) * 100 : 0;
            return (
              <div key={bucket.key} className="lh-card-soft p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted">{bucket.label}</p>
                  <StatusPill label={String(bucket.count)} tone={bucket.count ? bucket.tone : 'neutral'} />
                </div>
                <p className="mt-2.5 text-base font-semibold text-ink tabular-nums">{formatMoney(bucket.outstanding)}</p>
                <p className="mt-1 text-xs text-body">{bucket.detail}</p>
                <div className="mt-2 h-1 rounded-full bg-line">
                  <div
                    className={`h-1 rounded-full ${bucket.key === '90+' ? 'bg-danger' : bucket.key === 'current' ? 'bg-brand' : 'bg-warning'}`}
                    style={{ width: `${Math.max(share > 0 ? 4 : 0, share)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="lh-card-pad">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Accounts needing attention</h2>
          <SectionSearch value={query} onChange={setQuery} placeholder="Search attention queue" />
        </div>
        <div className="mt-3 space-y-2">
          {overdueAccounts.length ? overdueAccounts.map((account) => (
            <button key={account.patient} type="button" onClick={() => openAccount(account.patient)} className="lh-list-row flex w-full items-center justify-between p-3 text-left">
              <div>
                <p className="font-medium text-ink">{account.patient}</p>
                <p className="mt-1 text-xs text-body">{account.statement.open.length} open invoice{account.statement.open.length === 1 ? '' : 's'} · oldest {account.statement.oldestDays} days</p>
              </div>
              <p className="font-semibold text-ink tabular-nums">{formatMoney(account.statement.outstanding, account.statement.currency)}</p>
            </button>
          )) : (
            <EmptyState title="No overdue accounts" detail="Patient accounts with overdue balances will appear here." />
          )}
        </div>
      </section>
    </div>
  );
}

function AccountsView({ accounts, query, setQuery, openAccount, formatMoney }) {
  return (
    <section className="lh-card-pad space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Patient accounts</h2>
          <p className="mt-1 text-sm text-body">Open one account to work without seeing other patient names.</p>
        </div>
        <SectionSearch value={query} onChange={setQuery} placeholder="Search accounts" />
      </div>
      {accounts.length ? (
      <div className="grid gap-3 lg:grid-cols-2">
        {accounts.map((account) => (
          <button key={account.patient} type="button" onClick={() => openAccount(account.patient)} className="lh-list-row p-4 text-left">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-ink">{account.patient}</p>
                <p className="mt-1 text-xs text-body">{account.invoices.length} invoice{account.invoices.length === 1 ? '' : 's'} · last {account.lastInvoice?.id || 'none'}</p>
              </div>
              <StatusPill label={account.statement.outstanding > 0 ? 'Open' : 'Settled'} tone={account.statement.outstanding > 0 ? 'warm' : 'success'} />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <span className="text-body">Billed</span>
              <span className="text-body">Patient AR</span>
              <span className="text-body">Insurer</span>
              <span className="font-semibold text-ink tabular-nums">{formatMoney(account.statement.billed, account.statement.currency)}</span>
              <span className="font-semibold text-ink tabular-nums">{formatMoney(account.statement.outstanding, account.statement.currency)}</span>
              <span className="font-semibold text-ink tabular-nums">{formatMoney(account.insurerExposure, account.statement.currency)}</span>
            </div>
          </button>
        ))}
      </div>
      ) : (
        <EmptyState title="No accounts found" detail="Try another search term or widen the billing range." />
      )}
    </section>
  );
}

function StatementsView({ accounts, selectedPatient, setSelectedPatient, query, setQuery, range, customFrom, customTo, practiceInvoices, formatMoney, currency, outstandingOn, today }) {
  const selectedAccount = accounts.find((account) => account.patient === selectedPatient) || null;
  const filteredAccounts = accounts.filter((account) =>
    matchesQuery(query, account.patient, account.lastInvoice?.id, account.statement.outstanding, account.insurerExposure)
  );

  if (!selectedAccount) {
    return (
      <section className="lh-card-pad space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Patient statements</h2>
            <p className="mt-1 text-sm text-body">Choose one patient to view the full account ledger and balances.</p>
          </div>
          <SectionSearch value={query} onChange={setQuery} placeholder="Search statements" />
        </div>
        {filteredAccounts.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {filteredAccounts.map((account) => (
            <button key={account.patient} type="button" onClick={() => setSelectedPatient(account.patient)} className="lh-list-row p-4 text-left">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-ink">{account.patient}</p>
                  <p className="mt-1 text-xs text-body">{account.statement.open.length} open invoice{account.statement.open.length === 1 ? '' : 's'} | last {account.lastInvoice?.id || 'none'}</p>
                </div>
                <StatusPill label={account.statement.outstanding > 0 ? 'Open balance' : 'Settled'} tone={account.statement.outstanding > 0 ? 'warm' : 'success'} />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                <span className="text-body">Patient AR</span>
                <span className="text-body">Insurer</span>
                <span className="text-body">Billed</span>
                <span className="font-semibold text-ink tabular-nums">{formatMoney(account.statement.outstanding, account.statement.currency)}</span>
                <span className="font-semibold text-ink tabular-nums">{formatMoney(account.insurerExposure, account.statement.currency)}</span>
                <span className="font-semibold text-ink tabular-nums">{formatMoney(account.statement.billed, account.statement.currency)}</span>
              </div>
            </button>
          ))}
        </div>
        ) : (
          <EmptyState title="No statements found" detail="Try another patient name or widen the billing range." />
        )}
      </section>
    );
  }

  const statement = buildPatientLedger(selectedAccount.patient, practiceInvoices, formatMoney);
  const rows = statement.ledger.filter((row) => rowInStatementRange(row, range, today, customFrom, customTo));
  const invoices = selectedAccount.invoices;
  const insurerExposure = invoices.reduce((sum, invoice) => sum + summariseLines(invoice.services || []).outstandingFunder, 0);
  const billed = invoices.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
  const patientResponsibility = invoices.reduce((sum, invoice) => sum + Number(invoice.patientResponsibility || 0), 0);
  const collected = invoices.reduce((sum, invoice) => sum + paidSoFar(invoice.payments), 0);
  const adjusted = invoices.reduce((sum, invoice) => sum + adjustedTotal(invoice.adjustments), 0);
  const openInvoices = invoices.filter((invoice) => outstandingOn(invoice) > 0);

  return (
    <div className="space-y-5">
      <section className="lh-card-pad">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <button type="button" onClick={() => setSelectedPatient('')} className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-teal">
              <ArrowLeft size={14} /> All statements
            </button>
            <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">{selectedAccount.patient}</h2>
            <p className="mt-1 text-sm text-body">Patient account statement. No other patient accounts are shown in this view.</p>
          </div>
          <StatusPill label={BILLING_RANGES.find((option) => option.key === range)?.label || 'Statement range'} tone="neutral" />
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <Metric label="Invoice total" value={currency(billed)} detail="Gross billed value" />
          <Metric label="Patient portion" value={currency(patientResponsibility)} detail="Collectable from patient" />
          <Metric label="Paid" value={currency(collected)} detail="Receipts applied" tone="success" />
          <Metric label="Adjusted" value={currency(adjusted)} detail="Credits/write-offs" tone={adjusted > 0 ? 'alert' : 'neutral'} />
          <Metric label="Closing balance" value={formatMoney(statement.outstanding, statement.currency)} detail={`${openInvoices.length} open invoice${openInvoices.length === 1 ? '' : 's'}`} tone={statement.outstanding > 0 ? 'warm' : 'success'} />
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="lh-card-pad">
          <div className="flex items-center justify-between gap-3">
            <h3 className="lh-section-label">Statement ledger</h3>
            <StatusPill label={BILLING_RANGES.find((option) => option.key === range)?.label || 'Statement'} tone="neutral" />
          </div>
          <LedgerTable rows={rows} formatMoney={formatMoney} />
        </div>

        <div className="space-y-5">
          <section className="lh-card-pad">
            <h3 className="lh-section-label">Debt split</h3>
            <div className="mt-3 grid gap-2 text-sm">
              <InfoRow label="Patient outstanding" value={formatMoney(statement.outstanding, statement.currency)} danger={statement.outstanding > 0} />
              <InfoRow label="Insurer outstanding" value={currency(insurerExposure)} danger={insurerExposure > 0} />
              <InfoRow label="Open invoices" value={String(openInvoices.length)} />
            </div>
          </section>

          <section className="lh-card-pad">
            <h3 className="lh-section-label">Open invoices</h3>
            <div className="mt-3 space-y-2">
              {openInvoices.length ? openInvoices.map((invoice) => (
                <div key={invoice.id} className="rounded-md border border-line bg-white p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-ink">{invoice.id}</p>
                      <p className="mt-1 text-xs text-body">{invoice.claimStatus || 'Draft claim'}</p>
                    </div>
                    <p className="font-semibold tabular-nums text-ink">{formatMoney(outstandingOn(invoice), invoice.currency)}</p>
                  </div>
                </div>
              )) : (
                <EmptyState title="No open invoices" detail="This patient account is settled." />
              )}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function PatientAccountView({ account, statement, claims, onBack, openInvoice, openPatientStatement, takePayment, takeAdjustment, openStatement, reprintReceipt, openReceipt, can, currency, formatMoney, outstandingOn }) {
  const openInvoices = account.invoices.filter((invoice) => outstandingOn(invoice) > 0);
  const payments = account.invoices.flatMap((invoice) => (invoice.payments || []).map((payment) => ({ ...payment, invoice })));

  return (
    <div className="space-y-5">
      <section className="lh-card-pad">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-teal">
              <ArrowLeft size={14} /> All accounts
            </button>
            <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">{account.patient}</h2>
            <p className="mt-1 text-sm text-body">Patient account view. Only this patient&apos;s billing records are shown.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => openPatientStatement(account.patient)} className="lh-secondary-button">
              <FileText size={14} /> View statement
            </button>
            <button type="button" onClick={() => openStatement(account.patient)} className="lh-secondary-button">
              <FileText size={14} /> Settle account
            </button>
            {openInvoices[0] && can.recordPayment && (
              <button type="button" onClick={() => takePayment(openInvoices[0])} className="lh-secondary-button">
                <Receipt size={14} /> Record payment
              </button>
            )}
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Metric label="Billed" value={formatMoney(statement.billed, statement.currency)} detail="Patient liability raised" />
          <Metric label="Collected" value={formatMoney(statement.collected, statement.currency)} detail="Receipted payments" tone="success" />
          <Metric label="Written off" value={formatMoney(statement.adjusted, statement.currency)} detail="Credits and write-offs" tone={statement.adjusted > 0 ? 'alert' : 'neutral'} />
          <Metric label="Closing balance" value={formatMoney(statement.outstanding, statement.currency)} detail={`${statement.open.length} open invoice${statement.open.length === 1 ? '' : 's'}`} tone={statement.outstanding > 0 ? 'warm' : 'success'} />
        </div>
      </section>

      <section className="lh-card-pad">
        <h3 className="lh-section-label">Statement ledger</h3>
        <LedgerTable rows={statement.ledger} formatMoney={formatMoney} />
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <div className="lh-card-pad">
          <h3 className="lh-section-label">Invoices</h3>
          <div className="mt-3 space-y-2">
            {account.invoices.map((invoice) => (
              <InvoiceRow
                key={invoice.id}
                invoice={invoice}
                onSelect={() => openInvoice(invoice)}
                takePayment={takePayment}
                takeAdjustment={takeAdjustment}
                can={can}
                currency={currency}
                outstandingOn={outstandingOn}
              />
            ))}
          </div>
        </div>

        <div className="lh-card-pad">
          <h3 className="lh-section-label">Claims</h3>
          <div className="mt-3 space-y-2">
            {claims.length ? claims.map((claim) => (
              <div key={claim.id} className="rounded-md border border-line bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-ink">{claim.id}</p>
                    <p className="mt-1 text-xs text-body">{claim.plan || claim.payerName || 'No payer'} · {claim.submissionChannel || claim.channel || 'Switch'}</p>
                  </div>
                  <StatusPill label={claim.status} tone={claimStatusTone[claim.status] ?? 'neutral'} />
                </div>
              </div>
            )) : (
              <EmptyState title="No claims" detail="Claims for this patient will appear here." />
            )}
          </div>
        </div>
      </section>

      <section className="lh-card-pad">
        <h3 className="lh-section-label">Payments</h3>
        <PaymentsList payments={payments} reprintReceipt={reprintReceipt} onOpenReceipt={openReceipt} formatMoney={formatMoney} />
      </section>
    </div>
  );
}

function LedgerTable({ rows, formatMoney }) {
  if (!rows.length) return <EmptyState title="No ledger entries" detail="Invoices, payments, reversals, and adjustments will appear here." />;
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-white">
      <table className="min-w-[760px] w-full text-left text-sm">
        <thead className="bg-surface text-xs uppercase tracking-[0.08em] text-muted">
          <tr>
            <th className="px-3 py-2 font-semibold">Date</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-3 py-2 font-semibold">Reference</th>
            <th className="px-3 py-2 font-semibold">Detail</th>
            <th className="px-3 py-2 text-right font-semibold">Debit</th>
            <th className="px-3 py-2 text-right font-semibold">Credit</th>
            <th className="px-3 py-2 text-right font-semibold">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.type}-${row.ref}-${row.sort}`} className="border-t border-line">
              <td className="px-3 py-2 text-body">{String(row.date).slice(0, 10)}</td>
              <td className="px-3 py-2 font-medium text-ink">{row.type}</td>
              <td className="px-3 py-2 text-body">{row.ref}</td>
              <td className="px-3 py-2 text-body">{row.detail}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink">{row.debit ? formatMoney(row.debit, row.currency) : '-'}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink">{row.credit ? formatMoney(row.credit, row.currency) : '-'}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">{row.formattedBalance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoicesView({ invoices, selectedInvoice, openInvoice, takePayment, takeAdjustment, can, currency, formatMoney, outstandingOn, selectedInvoiceCurrency, selectedInvoiceOutstanding, selectedInvoiceDays, query, setQuery, openReceipt, claimForInvoice }) {
  const filteredInvoices = invoices.filter((invoice) =>
    matchesQuery(
      query,
      invoice.id,
      invoice.patient,
      invoice.claim,
      invoice.claimStatus,
      invoice.status,
      invoice.amount,
      invoice.services?.map((line) => `${line.code} ${line.desc}`).join(' ')
    )
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="lh-card-pad">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Invoices</h2>
          <SectionSearch value={query} onChange={setQuery} placeholder="Search invoices" />
        </div>
        <div className="mt-4 space-y-2">
          {filteredInvoices.length ? filteredInvoices.map((invoice) => (
            <InvoiceRow
              key={invoice.id}
              invoice={invoice}
              active={selectedInvoice?.id === invoice.id}
              onSelect={() => openInvoice(invoice)}
              takePayment={takePayment}
              takeAdjustment={takeAdjustment}
              can={can}
              currency={currency}
              outstandingOn={outstandingOn}
            />
          )) : (
            <EmptyState title="No invoices found" detail="Try a patient, invoice, service, claim status, or amount." />
          )}
        </div>
      </section>

      <section className="lh-card-pad">
        {selectedInvoice ? (
          <InvoiceDetail
            invoice={selectedInvoice}
            takePayment={takePayment}
            takeAdjustment={takeAdjustment}
            can={can}
            currency={currency}
            formatMoney={formatMoney}
            invoiceCurrency={selectedInvoiceCurrency}
            outstanding={selectedInvoiceOutstanding}
            days={selectedInvoiceDays}
            openReceipt={openReceipt}
            claim={claimForInvoice(selectedInvoice)}
          />
        ) : (
          <EmptyState title="No invoice selected" detail="Choose an invoice to see its services, claims, payments, and adjustments." />
        )}
      </section>
    </div>
  );
}

function InvoiceRow({ invoice, active, onSelect, takePayment, takeAdjustment, can, currency, outstandingOn }) {
  const outstanding = outstandingOn(invoice);
  return (
    <div className={`rounded-lg border p-3 ${active ? 'border-brand-edge bg-brand-soft' : 'border-line bg-white'}`}>
      <button type="button" onClick={onSelect} className="flex w-full items-start justify-between gap-3 text-left">
        <div>
          <p className="font-medium text-ink">{invoice.id}</p>
          <p className="mt-1 text-xs font-medium text-ink-soft">{invoice.patient}</p>
          <p className="mt-1 text-xs text-body">{invoice.date} · {invoice.dueDate} · {invoice.claim}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-ink tabular-nums">{currency(invoice.amount)}</p>
          <StatusPill label={invoice.status} tone={invoice.tone} />
        </div>
      </button>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-xs">
        <span className={outstanding > 0 ? 'text-danger-deep' : 'text-success'}>{currency(outstanding)} patient outstanding</span>
        <span className="flex gap-2">
          {can.recordPayment && outstanding > 0 && (
            <button type="button" onClick={() => takePayment(invoice)} className="font-semibold text-brand">Pay</button>
          )}
          {can.adjustBalance && outstanding > 0 && (
            <button type="button" onClick={() => takeAdjustment(invoice)} className="font-semibold text-danger">Adjust</button>
          )}
        </span>
      </div>
    </div>
  );
}

function InvoiceDetail({ invoice, takePayment, takeAdjustment, can, currency, formatMoney, invoiceCurrency, outstanding, days, openReceipt, claim }) {
  const payments = invoice.payments || [];
  const adjustments = invoice.adjustments || [];
  const funder = summariseLines(invoice.services || []);
  const paid = paidSoFar(payments);
  const adjusted = adjustedTotal(adjustments);
  const provider = invoice.provider || claim?.provider || 'Not recorded';
  const serviceDate = invoice.serviceDate || claim?.serviceDate || invoice.issuedOn || invoice.date || 'Not recorded';
  const memberNo = invoice.memberNo || claim?.memberNo || 'Not recorded';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="lh-section-label">Invoice detail</p>
          <h2 className="mt-2 text-lg font-semibold text-ink">{invoice.id}</h2>
          <p className="mt-1 text-sm text-body">{invoice.patient}</p>
        </div>
        <StatusPill label={invoice.claimStatus} tone={claimStatusTone[invoice.claimStatus] ?? 'neutral'} />
      </div>

      <div className="grid gap-2 text-sm">
        <InfoRow label="Patient" value={invoice.patient} />
        <InfoRow label="Issued" value={invoice.issuedOn || invoice.date || 'Not recorded'} />
        <InfoRow label="Due" value={invoice.dueOn || invoice.dueDate || 'Not recorded'} />
        <InfoRow label="Service date" value={serviceDate} />
        <InfoRow label="Provider" value={provider} />
        <InfoRow label="Medical aid / cover" value={invoice.insurance || 'Self-pay'} />
        <InfoRow label="Member number" value={memberNo} />
        <InfoRow label="Claim reference" value={invoice.claim || 'Not submitted'} />
        <InfoRow label="Claim status" value={invoice.claimStatus || 'Draft'} />
      </div>

      <div className="grid gap-2 text-sm">
        <InfoRow label="Invoice total" value={currency(invoice.amount)} />
        <InfoRow label="Medical aid estimated" value={currency(funder.estimatedFunder)} />
        <InfoRow label="Medical aid approved" value={currency(funder.funderApproved)} />
        <InfoRow label="Medical aid outstanding" value={currency(funder.outstandingFunder)} />
        <InfoRow label="Patient responsibility" value={currency(invoice.patientResponsibility)} />
        <InfoRow label="Payments received" value={formatMoney(paid, invoiceCurrency)} />
        <InfoRow label="Credits/write-offs" value={formatMoney(adjusted, invoiceCurrency)} />
        <InfoRow label="Patient outstanding" value={formatMoney(outstanding, invoiceCurrency)} danger={outstanding > 0} />
        {outstanding > 0 && days > 0 && <p className="text-xs font-medium text-danger-deep">{days} days past due</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        {can.recordPayment && outstanding > 0 && (
          <button type="button" onClick={() => takePayment(invoice)} className="lh-primary-button">
            <Receipt size={14} /> Record payment
          </button>
        )}
        {can.adjustBalance && outstanding > 0 && (
          <button type="button" onClick={() => takeAdjustment(invoice)} className="lh-secondary-button text-danger-deep">
            <Scissors size={14} /> Write off or credit
          </button>
        )}
      </div>

      <div>
        <p className="lh-section-label">Service lines</p>
        <div className="mt-2 space-y-2">
          {(invoice.services || []).map((line, index) => {
            const settled = isAdjudicated(line);
            return (
              <div key={`${line.code}-${index}`} className="rounded-md border border-line bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-ink">{line.desc}</p>
                    <p className="mt-1 text-xs text-body">{line.code}{line.tariffVia ? ` · ${line.tariffVia}` : ''}</p>
                    {line.priceChanged && (
                      <p className="mt-1 text-xs text-warning-deep">
                        {line.pricingMode || 'Custom price'} · standard {currency(line.standardUnitPrice ?? line.unitPrice ?? 0)} · reason {line.priceReason || 'not recorded'}
                        {line.priceNote ? ` · ${line.priceNote}` : ''}
                      </p>
                    )}
                  </div>
                  <p className="font-semibold text-ink tabular-nums">{currency(line.gross ?? line.amount)}</p>
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-xs">
                  <span className={settled ? 'text-success' : 'text-muted'}>{settled ? 'Medical aid approved' : 'Medical aid estimated'}</span>
                  <span className="tabular-nums text-ink">{currency(settled ? line.actualFunderApproved : (line.estimatedFunder ?? line.insurance ?? 0))}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {adjustments.length > 0 && (
        <div>
          <p className="lh-section-label">Write-offs and credits</p>
          <div className="mt-2 space-y-2">
            {adjustments.map((adjustment) => (
              <div key={adjustment.id} className="rounded-md border border-line bg-surface p-3 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="font-medium text-ink">{adjustmentLabel(adjustment.type)}</span>
                  <span className="tabular-nums text-body">-{formatMoney(adjustment.amount, adjustment.currency)}</span>
                </div>
                <p className="mt-1 text-xs text-body">{adjustment.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <PaymentsList payments={payments.map((payment) => ({ ...payment, invoice }))} onOpenReceipt={openReceipt} formatMoney={formatMoney} />
    </div>
  );
}

function InfoRow({ label, value, danger }) {
  return (
    <div className="flex items-center justify-between border-b border-line pb-2 last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className={`font-medium tabular-nums ${danger ? 'text-danger-deep' : 'text-ink'}`}>{value}</span>
    </div>
  );
}

function InvoiceModal({ invoice, onClose, takePayment, takeAdjustment, can, currency, formatMoney, outstanding, days, onPrint, openReceipt, claim }) {
  if (!invoice) return null;
  const invoiceCurrency = invoice.currency || 'USD';

  return (
    <Modal
      open={Boolean(invoice)}
      onClose={onClose}
      title={`Invoice ${invoice.id}`}
      subtitle={`${invoice.patient} · ${invoice.date || 'No issue date'}`}
      width="max-w-4xl"
      footer={(
        <>
          <button type="button" onClick={onClose} className="lh-secondary-button">Close</button>
          <button type="button" onClick={() => onPrint(invoice)} className="lh-primary-button">
            <Printer size={14} /> Print invoice
          </button>
        </>
      )}
    >
      <InvoiceDetail
        invoice={invoice}
        takePayment={takePayment}
        takeAdjustment={takeAdjustment}
        can={can}
        currency={currency}
        formatMoney={formatMoney}
        invoiceCurrency={invoiceCurrency}
        outstanding={outstanding}
        days={days}
        openReceipt={openReceipt}
        claim={claim}
      />
    </Modal>
  );
}

function InvoicePrintDocument({ invoice, claim, formatMoney }) {
  if (!invoice) return null;
  const invoiceCurrency = invoice.currency || 'USD';
  const payments = invoice.payments || [];
  const adjustments = invoice.adjustments || [];
  const paid = paidSoFar(payments);
  const adjusted = adjustedTotal(adjustments);
  const outstanding = Math.max(0, Number(invoice.patientResponsibility || 0) - paid - adjusted);
  const services = invoice.services || [];
  const provider = invoice.provider || claim?.provider || 'Not recorded';
  const serviceDate = invoice.serviceDate || claim?.serviceDate || invoice.issuedOn || invoice.date || 'Not recorded';
  const memberNo = invoice.memberNo || claim?.memberNo || 'Not recorded';

  return (
    <article className="lh-print-invoice-doc">
      <header className="lh-invoice-print-head">
        <div>
          <p className="lh-invoice-print-brand">Luminary Health</p>
          <p className="lh-invoice-print-meta">Patient invoice</p>
        </div>
        <div className="lh-invoice-print-stamp">
          <p className="lh-invoice-print-title">Invoice</p>
          <p>{invoice.id}</p>
        </div>
      </header>

      <section className="lh-invoice-print-grid">
        <div>
          <p className="lh-invoice-print-label">Bill to</p>
          <p className="lh-invoice-print-strong">{invoice.patient}</p>
          <p>{invoice.insurance}</p>
          <p>Member: {memberNo}</p>
        </div>
        <div>
          <p className="lh-invoice-print-label">Dates</p>
          <p>Issued: {invoice.issuedOn || invoice.date}</p>
          <p>Due: {invoice.dueOn || invoice.dueDate}</p>
          <p>Service: {serviceDate}</p>
        </div>
        <div>
          <p className="lh-invoice-print-label">Claim</p>
          <p>{invoice.claim}</p>
          <p>{invoice.claimStatus}</p>
          <p>Provider: {provider}</p>
        </div>
      </section>

      <table className="lh-invoice-print-table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Code</th>
            <th>Qty</th>
            <th>Medical aid</th>
            <th>Patient</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {services.map((line, index) => (
            <tr key={`${line.code}-${index}`}>
              <td>
                <strong>{line.desc}</strong>
                {line.priceChanged && <span>Price: {line.pricingMode}; reason: {line.priceReason || 'not recorded'}</span>}
              </td>
              <td>{line.code || '-'}</td>
              <td>{line.quantity || 1}</td>
              <td>{formatMoney(line.estimatedFunder ?? line.insurance ?? 0, invoiceCurrency)}</td>
              <td>{formatMoney(line.estimatedPatient ?? Math.max(0, Number(line.gross ?? line.amount ?? 0) - Number(line.estimatedFunder ?? line.insurance ?? 0)), invoiceCurrency)}</td>
              <td>{formatMoney(line.gross ?? line.amount ?? 0, invoiceCurrency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="lh-invoice-print-totals">
        <dl>
          <div><dt>Invoice total</dt><dd>{formatMoney(invoice.amount, invoiceCurrency)}</dd></div>
          <div><dt>Patient responsibility</dt><dd>{formatMoney(invoice.patientResponsibility, invoiceCurrency)}</dd></div>
          <div><dt>Payments</dt><dd>{formatMoney(paid, invoiceCurrency)}</dd></div>
          <div><dt>Credits/write-offs</dt><dd>{formatMoney(adjusted, invoiceCurrency)}</dd></div>
          <div className="lh-invoice-print-balance"><dt>Balance due</dt><dd>{formatMoney(outstanding, invoiceCurrency)}</dd></div>
        </dl>
      </section>
    </article>
  );
}

function ClaimsExposureView({ invoices, claims, currency, openAccount, query, setQuery }) {
  const rows = invoices
    .map((invoice) => {
      const funder = summariseLines(invoice.services || []);
      const claim = claims.find((item) => item.id === invoice.claim);
      return { invoice, funder, claim };
    })
    .filter((row) => row.funder.estimatedFunder > 0 || row.funder.outstandingFunder > 0 || row.claim)
    .filter(({ invoice, funder, claim }) =>
      matchesQuery(query, invoice.id, invoice.patient, invoice.claim, invoice.claimStatus, claim?.id, claim?.status, claim?.plan, claim?.payerName, funder.estimatedFunder, funder.funderApproved, funder.outstandingFunder)
    );

  return (
    <section className="lh-card-pad space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Claims and insurer exposure</h2>
        <SectionSearch value={query} onChange={setQuery} placeholder="Search claims exposure" />
      </div>
      {rows.length ? (
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="min-w-[820px] w-full text-left text-sm">
          <thead className="bg-surface text-xs uppercase tracking-[0.08em] text-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">Invoice</th>
              <th className="px-3 py-2 font-semibold">Patient</th>
              <th className="px-3 py-2 font-semibold">Claim</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 text-right font-semibold">Estimated</th>
              <th className="px-3 py-2 text-right font-semibold">Approved</th>
              <th className="px-3 py-2 text-right font-semibold">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ invoice, funder, claim }) => (
              <tr key={invoice.id} className="border-t border-line">
                <td className="px-3 py-2 font-medium text-ink">{invoice.id}</td>
                <td className="px-3 py-2">
                  <button type="button" onClick={() => openAccount(invoice.patient)} className="font-medium text-brand hover:underline">{invoice.patient}</button>
                </td>
                <td className="px-3 py-2 text-body">{claim?.id || invoice.claim || 'Not submitted'}</td>
                <td className="px-3 py-2"><StatusPill label={claim?.status || invoice.claimStatus || 'Draft'} tone={claimStatusTone[claim?.status || invoice.claimStatus] ?? 'neutral'} /></td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">{currency(funder.estimatedFunder)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">{currency(funder.funderApproved)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">{currency(funder.outstandingFunder)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : (
        <EmptyState title="No claims exposure found" detail="Try a patient, invoice, claim, payer, status, or amount." />
      )}
    </section>
  );
}

function ReceiptsView({ invoices, reprintReceipt, openReceipt, formatMoney, query, setQuery, range, rangeBounds, outstandingOn }) {
  const payments = invoices
    .flatMap((invoice) => (invoice.payments || []).filter((payment) => payment.amount > 0).map((payment) => ({ ...payment, invoice })))
    .filter((payment) => paymentInBillingRange(payment, range, rangeBounds, outstandingOn))
    .filter((payment) => matchesQuery(query, payment.id, payment.invoice.id, payment.invoice.patient, payment.method, payment.amount, payment.currency, payment.receivedBy))
    .sort((a, b) => paymentDate(b) - paymentDate(a));

  return (
    <section className="lh-card-pad space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Receipts</h2>
        <SectionSearch value={query} onChange={setQuery} placeholder="Search receipts" />
      </div>
      <PaymentsList payments={payments} reprintReceipt={reprintReceipt} onOpenReceipt={openReceipt} formatMoney={formatMoney} />
    </section>
  );
}

function PaymentsList({ payments, reprintReceipt, onOpenReceipt, formatMoney }) {
  if (!payments.length) return <EmptyState title="No payments" detail="Receipts and reversals will appear here after payment is recorded." />;
  return (
    <div className="space-y-2">
      {payments.map((payment) => {
        const reversal = payment.amount < 0;
        return (
          <div key={`${payment.invoice.id}-${payment.id}`} className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${reversal ? 'border-danger-line bg-danger-soft' : 'border-line bg-white'}`}>
            <button type="button" onClick={() => onOpenReceipt?.(payment)} className="min-w-0 flex-1 text-left" title="View receipt">
              <p className="font-medium text-ink">{reversal ? 'Reversal' : methodLabel(payment.method)}</p>
              <p className="mt-1 text-xs text-body">{payment.invoice.id} · {new Date(payment.receivedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {payment.receivedBy}</p>
            </button>
            <div className="flex items-center gap-3">
              <p className={`font-semibold tabular-nums ${reversal ? 'text-danger-deep' : 'text-ink'}`}>{formatMoney(payment.amount, payment.currency)}</p>
              {reprintReceipt && !reversal && (
                <button type="button" title="Reprint this receipt" onClick={() => reprintReceipt(payment.invoice, payment)} className="rounded border border-line bg-white p-1.5 text-muted transition hover:border-brand-edge hover:text-brand">
                  <Printer size={13} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReceiptModal({ payment, onClose, onPrint, formatMoney }) {
  if (!payment) return null;
  const invoice = payment.invoice || {};
  const reversal = Number(payment.amount || 0) < 0;
  const fxRate = Number(payment.fxRate || 1);
  const appliedAmount = Number(payment.amount || 0) * fxRate;
  const invoiceCurrency = invoice.currency || payment.currency || 'USD';
  const remainingBalance = invoice.id ? balanceAfter(invoice, payment.id) : Math.max(0, Number(invoice.patientResponsibility || 0) - appliedAmount);
  const receivedAt = payment.receivedAt
    ? new Date(payment.receivedAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })
    : 'Not recorded';

  return (
    <Modal
      open={Boolean(payment)}
      onClose={onClose}
      title={`Receipt ${payment.id}`}
      subtitle={`${invoice.patient || 'Unknown patient'} | ${invoice.id || 'No invoice'}`}
      width="max-w-2xl"
      footer={(
        <>
          <button type="button" onClick={onClose} className="lh-secondary-button">Close</button>
          {!reversal && (
            <button type="button" onClick={() => onPrint(payment)} className="lh-primary-button">
              <Printer size={14} /> Print receipt
            </button>
          )}
        </>
      )}
    >
      <div className="space-y-4">
        <div className={`rounded-lg border p-4 ${reversal ? 'border-danger-line bg-danger-soft' : 'border-brand-edge bg-brand-soft'}`}>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{reversal ? 'Reversal entry' : 'Receipt amount'}</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${reversal ? 'text-danger-deep' : 'text-ink'}`}>
            {formatMoney(payment.amount, payment.currency)}
          </p>
          <p className="mt-1 text-sm text-body">
            Applied as {formatMoney(appliedAmount, invoiceCurrency)}{fxRate !== 1 ? ` at FX rate ${fxRate}` : ''}
          </p>
        </div>

        <div className="grid gap-2 text-sm">
          <InfoRow label="Patient" value={invoice.patient || 'Unknown patient'} />
          <InfoRow label="Invoice" value={invoice.id || 'Not linked'} />
          <InfoRow label="Payment reference" value={payment.id} />
          <InfoRow label="Method" value={methodLabel(payment.method)} />
          <InfoRow label="Received at" value={receivedAt} />
          <InfoRow label="Received by" value={payment.receivedBy || 'Not recorded'} />
          <InfoRow label="Claim" value={invoice.claim || 'Not submitted'} />
          <InfoRow label="Medical aid" value={invoice.insurance || 'Self-pay'} />
          <InfoRow label="Invoice total" value={formatMoney(invoice.amount || 0, invoiceCurrency)} />
          <InfoRow label="Patient responsibility" value={formatMoney(invoice.patientResponsibility || 0, invoiceCurrency)} />
          <InfoRow label="Amount allocated" value={formatMoney(appliedAmount, invoiceCurrency)} />
          <InfoRow label="Balance after receipt" value={formatMoney(remainingBalance, invoiceCurrency)} danger={remainingBalance > 0} />
        </div>

        {invoice.services?.length > 0 && (
          <div>
            <p className="lh-section-label">Invoice services</p>
            <div className="mt-2 space-y-2">
              {invoice.services.map((line, index) => (
                <div key={`${line.code || line.desc}-${index}`} className="flex items-start justify-between gap-3 rounded-md border border-line bg-white p-3 text-sm">
                  <div>
                    <p className="font-medium text-ink">{line.desc}</p>
                    <p className="mt-1 text-xs text-body">{line.code || 'No code'}</p>
                  </div>
                  <p className="font-semibold tabular-nums text-ink">{formatMoney(line.gross ?? line.amount ?? 0, invoice.currency || payment.currency)}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ReceiptBanner({ receipt, setReceipt, printReceipt, formatMoney }) {
  return (
    <div className="rounded-lg border border-brand-edge bg-white/85 p-5 shadow-[0_14px_36px_-28px_rgba(20,102,224,0.55)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-brand">Receipt{receipt.number ? ` · ${receipt.number}` : ''}</p>
          <p className="mt-2 text-md font-semibold text-ink">
            {formatMoney(receipt.tendered.amount, receipt.tendered.currency)} received from {receipt.patient}
          </p>
          <p className="mt-1 text-sm text-body">{receipt.invoiceReference} · {methodLabel(receipt.method)} · taken by {receipt.receivedBy}</p>
          {receipt.allocations?.length > 1 && (
            <p className="mt-1 text-sm text-body">
              Applied {receipt.allocations.map((item) => `${formatMoney(item.amount, receipt.appliedToInvoice.currency)} to ${item.invoiceId}`).join(', ')}, oldest first.
            </p>
          )}
          <p className="mt-2 text-sm font-medium text-ink">
            {receipt.balanceRemaining > 0 ? `${formatMoney(receipt.balanceRemaining, receipt.appliedToInvoice.currency)} still outstanding` : 'Invoice settled in full'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={printReceipt} className="lh-secondary-button px-3 py-1.5 text-brand">
            <Printer size={13} /> Print
          </button>
          <button type="button" onClick={() => setReceipt(null)} className="rounded px-3 py-1.5 text-sm font-medium text-body hover:text-ink">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
