import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  FileCheck2,
  FileText,
  Fingerprint,
  Inbox,
  Mail,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  UploadCloud,
  X,
} from 'lucide-react';
import { claimStatusTone } from '../../data/billing';
import { StatusPill } from '../shared/StatusPill';
import { EmptyState } from '../shared/EmptyState';
import { StickyBar } from '../ui';
import { useWorkspace } from '../../lib/workspace';
import { api } from '../../services/api';

const ACTION_STATUSES = new Set(['Validation failed', 'Rejected', 'Requires action', 'Query', 'Failed']);
const PREPARE_STATUSES = new Set(['Draft', 'Validation failed', 'Ready', 'Ready for submission', 'Biometric verified']);
const READY_STATUSES = new Set(['Ready', 'Ready for submission', 'Biometric verified']);
const EMAIL_STATUSES = new Set(['Form prepared', 'Awaiting client authentication', 'Client authenticated', 'Email submitted']);
const IN_FLIGHT_STATUSES = new Set(['Submitted', 'Acknowledged', 'Processing', 'Submitting', 'Email submitted']);
const APPROVED_STATUSES = new Set(['Approved', 'Adjudicated', 'Partially approved']);
const REMITTANCE_STATUSES = new Set(['Remitted']);

const MODULES = [
  {
    id: 'prepare',
    label: 'Prepare',
    detail: 'Complete patient, encounter, diagnosis, line, and document information.',
    matches: (claim) => PREPARE_STATUSES.has(claim.status) || blockerCount(claim) > 0,
    detailTabs: ['Summary', 'Coding', 'Validation', 'Documents'],
  },
  {
    id: 'submit',
    label: 'Submit',
    detail: 'Send verified claims and watch switch acceptance.',
    matches: (claim) => READY_STATUSES.has(claim.status),
    detailTabs: ['Summary', 'Submission', 'Validation', 'Timeline'],
  },
  {
    id: 'email',
    label: 'Email',
    detail: 'Prepare international claim forms, client authentication, and email submission.',
    matches: (claim) => EMAIL_STATUSES.has(claim.status) || (claim.submissionChannel || claim.channel) === 'Email',
    detailTabs: ['Summary', 'Email pack', 'Documents', 'Timeline'],
  },
  {
    id: 'track',
    label: 'Track',
    detail: 'Follow claims already with the payer or switch.',
    matches: (claim) => IN_FLIGHT_STATUSES.has(claim.status),
    detailTabs: ['Summary', 'Timeline', 'Lines', 'Adjudication'],
  },
  {
    id: 'resolve',
    label: 'Resolve',
    detail: 'Fix rejections, queries, and patient responsibility.',
    matches: (claim) => ACTION_STATUSES.has(claim.status),
    detailTabs: ['Summary', 'Validation', 'Adjudication', 'Documents'],
  },
  {
    id: 'remit',
    label: 'Remittances',
    detail: 'Post approved amounts and reconcile balances.',
    matches: (claim) => APPROVED_STATUSES.has(claim.status) || REMITTANCE_STATUSES.has(claim.status),
    detailTabs: ['Summary', 'Adjudication', 'Lines', 'Timeline'],
  },
];

const text = (value) => String(value ?? '').toLowerCase();
const moneyNumber = (claim, key, fallback = 0) => Number(claim?.[key] ?? fallback) || 0;
const displayCopy = (value) => String(value ?? '').replace(/Self-pay/g, 'Self pay').replace(/No-show/g, 'No show');

const claimAmount = (claim) => {
  if (claim?.amount) return claim.amount;
  const amount = moneyNumber(claim, 'claimed');
  return `${claim?.currency || 'USD'} ${amount.toFixed(2)}`;
};

const daysSince = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  parsed.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - parsed) / 86400000));
};

const blockerCount = (claim) => claim?.validation?.errors?.length ?? (claim?.icd10 === 'Not coded' ? 1 : 0);

function claimMatches(claim, query) {
  if (!query) return true;
  const haystack = [
    claim.id,
    claim.patient,
    claim.memberNo,
    claim.plan,
    claim.payerName,
    claim.provider,
    claim.invoice,
    claim.externalReference,
    claim.submissionChannel,
    claim.emailSubmission?.providerEmail,
    claim.emailSubmission?.claimForm,
    claim.status,
    claim.tariff,
    claim.icd10,
  ].map(text).join(' ');
  return haystack.includes(query);
}

function lineAmount(line) {
  const claimed = Number(line.claimed_amount ?? line.gross ?? line.amount ?? 0);
  const approved = Number(line.approved_amount ?? line.actualFunderApproved ?? 0);
  const rejected = Number(line.rejected_amount ?? 0);
  return { claimed, approved, rejected };
}

function invoiceInsurerAmount(invoice) {
  return Number(invoice?.insurerResponsibility || invoice?.estimatedInsurerResponsibility || 0)
    || (invoice?.services || []).reduce((sum, line) => sum + Number(line.insurance || line.estimatedFunder || 0), 0);
}

function moduleForClaim(claim) {
  if (EMAIL_STATUSES.has(claim.status) || (claim.submissionChannel || claim.channel) === 'Email') return MODULES.find((item) => item.id === 'email') || MODULES[0];
  if (ACTION_STATUSES.has(claim.status)) return MODULES.find((item) => item.id === 'resolve') || MODULES[0];
  if (READY_STATUSES.has(claim.status)) return MODULES.find((item) => item.id === 'submit') || MODULES[0];
  if (IN_FLIGHT_STATUSES.has(claim.status)) return MODULES.find((item) => item.id === 'track') || MODULES[0];
  if (APPROVED_STATUSES.has(claim.status) || REMITTANCE_STATUSES.has(claim.status)) return MODULES.find((item) => item.id === 'remit') || MODULES[0];
  return MODULES.find((item) => item.id === 'prepare') || MODULES[0];
}

export default function ClaimsPage() {
  const {
    access,
    exportCsv,
    notify,
    reloadWorkspace,
    practiceInvoices,
    practiceClaims,
    selectedClaim,
    setSelectedClaimId,
    createClaimFromInvoice,
    captureBiometric,
    submitClaimToSwitch,
    prepareEmailClaimForm,
    saveEmailClaimPreparation,
    sendClaimForClientAuthentication,
    authenticateEmailClaim,
    submitEmailClaim,
    recordAdjudication,
    proposePatientResponsibility,
    REJECTION_REASONS,
  } = useWorkspace();

  const [activeModule, setActiveModule] = useState('prepare');
  const [query, setQuery] = useState('');
  const [payerFilter, setPayerFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [detailTab, setDetailTab] = useState('Summary');
  const [queueOpen, setQueueOpen] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 1280px)').matches);
  const [newClaimOpen, setNewClaimOpen] = useState(false);
  const [newClaimInvoiceId, setNewClaimInvoiceId] = useState('');
  const [creatingClaim, setCreatingClaim] = useState(false);

  const module = MODULES.find((item) => item.id === activeModule) || MODULES[0];
  const normalizedQuery = query.trim().toLowerCase();
  const searchIsActive = normalizedQuery.length > 0;

  const claimsWithAge = useMemo(
    () => practiceClaims.map((claim) => ({
      ...claim,
      ageDays: daysSince(claim.submittedAt || claim.createdAt || claim.serviceDate),
    })),
    [practiceClaims]
  );

  const payers = useMemo(
    () => [...new Set(practiceClaims.map((claim) => claim.plan || claim.payerName).filter(Boolean))],
    [practiceClaims]
  );

  const channels = useMemo(
    () => [...new Set(practiceClaims.map((claim) => claim.submissionChannel || claim.channel).filter(Boolean))],
    [practiceClaims]
  );

  const moduleCounts = useMemo(() => MODULES.reduce((acc, item) => {
    acc[item.id] = claimsWithAge.filter(item.matches).length;
    return acc;
  }, {}), [claimsWithAge]);

  const filteredClaims = useMemo(
    () => claimsWithAge.filter((claim) => {
      const payer = claim.plan || claim.payerName;
      const channel = claim.submissionChannel || claim.channel;
      return (searchIsActive || module.matches(claim))
        && (payerFilter === 'all' || payer === payerFilter)
        && (channelFilter === 'all' || channel === channelFilter)
        && claimMatches(claim, normalizedQuery);
    }),
    [channelFilter, claimsWithAge, module, normalizedQuery, payerFilter, searchIsActive]
  );

  const visibleSelectedClaim = filteredClaims.find((claim) => claim.id === selectedClaim?.id)
    || filteredClaims[0]
    || null;
  const detailModule = searchIsActive && visibleSelectedClaim ? moduleForClaim(visibleSelectedClaim) : module;

  const selectedPatientClaims = useMemo(
    () => practiceClaims.filter((claim) => visibleSelectedClaim && claim.patient === visibleSelectedClaim.patient),
    [practiceClaims, visibleSelectedClaim]
  );

  const totals = useMemo(() => {
    const prepare = claimsWithAge.filter(MODULES[0].matches).length;
    const ready = claimsWithAge.filter((claim) => READY_STATUSES.has(claim.status)).length;
    const missingDiagnosis = claimsWithAge.filter((claim) => claim.icd10 === 'Not coded').length;
    const missingEncounter = claimsWithAge.filter((claim) => !claim.encounterId).length;
    const value = claimsWithAge.reduce((sum, claim) => sum + moneyNumber(claim, 'claimed'), 0);
    return { prepare, ready, missingDiagnosis, missingEncounter, value };
  }, [claimsWithAge]);

  const resetFilters = () => {
    setQuery('');
    setPayerFilter('all');
    setChannelFilter('all');
  };

  const coveredInvoices = useMemo(() => practiceInvoices.filter((invoice) => invoiceInsurerAmount(invoice) > 0), [practiceInvoices]);

  const claimableInvoices = useMemo(() => coveredInvoices.filter((invoice) =>
    !practiceClaims.some((claim) => claim.invoice === invoice.id)), [coveredInvoices, practiceClaims]);

  const selectedClaimInvoice = claimableInvoices.find((invoice) => (invoice.apiId || invoice.id) === newClaimInvoiceId);

  const createClaim = async () => {
    const invoice = selectedClaimInvoice;
    if (!invoice) return;
    setCreatingClaim(true);
    try {
      const createdId = await createClaimFromInvoice(invoice);
      setSelectedClaimId(createdId);
      setActiveModule('prepare');
      setDetailTab('Summary');
      setNewClaimOpen(false);
      setNewClaimInvoiceId('');
      notify(`Claim prepared from ${invoice.id}`);
    } catch (error) {
      notify(error.message);
    } finally {
      setCreatingClaim(false);
    }
  };

  const selectModule = (id) => {
    const next = MODULES.find((item) => item.id === id) || MODULES[0];
    setActiveModule(id);
    setDetailTab(next.detailTabs[0]);
    setQueueOpen(true);
  };

  if (practiceClaims.length === 0 && !newClaimOpen) {
    return (
      <EmptyState
        title="No claims in this practice"
        detail="Claims will appear here after an invoice is prepared for a covered patient."
        action={access.can.createClaims ? <button type="button" onClick={() => setNewClaimOpen(true)} className="lh-primary-button"><Plus size={16} />Prepare first claim</button> : null}
      />
    );
  }

  return (
    <div className="lh-has-sticky-bar min-w-0 max-w-full space-y-6 overflow-x-hidden">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-caption font-semibold text-teal">Claim preparation workspace</p>
            <StatusPill label={`${practiceClaims.length} claims`} tone="neutral" />
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-title text-ink sm:text-3xl">Medical aid claims</h1>
          <p className="mt-1 max-w-2xl text-sm text-body">
            Build a complete claim from the patient file, encounter, invoice, diagnoses, and supporting documents.
          </p>
        </div>
        {access.can.createClaims ? <button type="button" onClick={() => setNewClaimOpen((value) => !value)} className="lh-primary-button self-start">
          <Plus size={16} />New claim
        </button> : null}
      </div>

      {newClaimOpen ? (
        <section className="border-y border-line bg-white/55 px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-xs font-semibold text-ink">Invoice ready for a claim</span>
              <select value={newClaimInvoiceId} onChange={(event) => setNewClaimInvoiceId(event.target.value)} className="h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink outline-none focus:border-teal focus:ring-2 focus:ring-teal-soft">
                <option value="">Choose an unclaimed invoice</option>
                {claimableInvoices.map((invoice) => <option key={invoice.apiId || invoice.id} value={invoice.apiId || invoice.id}>{invoice.id} | {invoice.patient} | insurer portion {invoice.currency} {invoiceInsurerAmount(invoice).toFixed(2)}</option>)}
              </select>
            </label>
            <button type="button" disabled={!newClaimInvoiceId || creatingClaim} onClick={createClaim} className="lh-primary-button justify-center disabled:cursor-not-allowed disabled:opacity-50">
              {creatingClaim ? 'Creating...' : 'Start preparation'}
            </button>
            <button type="button" onClick={() => setNewClaimOpen(false)} className="lh-secondary-button justify-center">Cancel</button>
          </div>
          <p className="mt-3 text-xs text-body">A new patient appears here after an invoice with an insurer portion is issued. Invoices that already have claims stay in the claims queue and cannot be duplicated.</p>
          {!claimableInvoices.length ? <p className="mt-2 flex items-center gap-2 text-sm font-medium text-warning"><AlertTriangle size={15} />Every covered invoice currently has a claim. Issue another covered invoice to begin a new preparation.</p> : null}
        </section>
      ) : null}

      <div className="grid grid-flow-col auto-cols-[minmax(150px,1fr)] gap-3 overflow-x-auto pb-1 md:grid-flow-row md:grid-cols-5 md:overflow-visible md:pb-0">
        <SummaryTile label="In preparation" value={totals.prepare} detail="Drafts and reviewed claims" tone="neutral" />
        <SummaryTile label="Ready" value={totals.ready} detail="Required information complete" tone="success" />
        <SummaryTile label="Missing diagnosis" value={totals.missingDiagnosis} detail="Needs primary ICD-10" tone={totals.missingDiagnosis ? 'alert' : 'success'} />
        <SummaryTile label="Missing encounter" value={totals.missingEncounter} detail="Needs a signed source" tone={totals.missingEncounter ? 'warm' : 'success'} />
        <SummaryTile label="Claim value" value={`USD ${totals.value.toFixed(2)}`} detail="Across current claims" tone="accent" />
      </div>

      <ModuleNav activeModule={activeModule} counts={moduleCounts} onSelect={selectModule} />

      <section className="lh-card-pad space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-ink">{searchIsActive ? 'Search results' : module.label}</p>
            <p className="text-xs text-body">{searchIsActive ? 'Searching all claims across every claims module.' : module.detail}</p>
          </div>
          <StatusPill label={`${filteredClaims.length} visible`} tone={filteredClaims.length ? 'accent' : 'neutral'} />
        </div>

        <div className={`grid gap-3 ${activeModule === 'prepare' ? 'xl:grid-cols-[minmax(320px,0.9fr)_190px_auto_auto]' : 'xl:grid-cols-[minmax(320px,0.9fr)_190px_170px_auto_auto]'}`}>
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search patients, claims, invoices, members"
              className="h-10 w-full rounded-lg border border-line bg-white pl-9 pr-10 text-sm text-ink outline-none transition focus:border-teal focus:ring-2 focus:ring-teal-soft"
            />
            {query ? (
              <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted transition hover:bg-line hover:text-ink" aria-label="Clear search">
                <X size={15} />
              </button>
            ) : null}
          </label>

          <select value={payerFilter} onChange={(event) => setPayerFilter(event.target.value)} className="rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-teal focus:ring-2 focus:ring-teal-soft">
            <option value="all">All payers</option>
            {payers.map((payer) => <option key={payer} value={payer}>{payer}</option>)}
          </select>

          {activeModule !== 'prepare' ? <select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)} className="rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-teal focus:ring-2 focus:ring-teal-soft">
            <option value="all">All channels</option>
            {channels.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
          </select> : null}

          <button type="button" onClick={resetFilters} className="lh-secondary-button justify-center">
            <SlidersHorizontal size={15} />Reset
          </button>

          <button
            type="button"
            onClick={() => exportCsv(`claims-${activeModule}.csv`, [
              { label: 'Claim', get: (claim) => claim.id },
              { label: 'Patient', get: (claim) => claim.patient },
              { label: 'Member', get: (claim) => displayCopy(claim.memberNo) },
              { label: 'Invoice', get: (claim) => claim.invoice },
              { label: 'Payer', get: (claim) => claim.plan || claim.payerName },
              { label: 'Channel', get: (claim) => claim.submissionChannel || claim.channel || 'Manual' },
              { label: 'Status', get: (claim) => claim.status },
              { label: 'Amount', get: claimAmount },
              { label: 'Blockers', get: blockerCount },
            ], filteredClaims)}
            className="lh-secondary-button justify-center"
          >
            <FileText size={15} />Export
          </button>
        </div>
      </section>

      <div className={`grid items-start gap-4 ${queueOpen ? 'xl:grid-cols-[420px,minmax(0,1fr)]' : 'xl:grid-cols-[88px,minmax(0,1fr)]'}`}>
        <ClaimsQueue
          claims={filteredClaims}
          selectedClaim={visibleSelectedClaim}
          queueOpen={queueOpen}
          setQueueOpen={setQueueOpen}
          onSelect={(claim) => {
            const nextModule = searchIsActive ? moduleForClaim(claim) : module;
            setActiveModule(nextModule.id);
            setSelectedClaimId(claim.id);
            setDetailTab(nextModule.detailTabs[0]);
            setQueueOpen(false);
          }}
        />

        {visibleSelectedClaim && detailModule.id === 'prepare' ? (
          <ClaimPreparationWorkspace
            claim={visibleSelectedClaim}
            access={access}
            notify={notify}
            reloadWorkspace={reloadWorkspace}
            setQueueOpen={setQueueOpen}
          />
        ) : visibleSelectedClaim ? (
          <ClaimModuleDetail
            claim={visibleSelectedClaim}
            module={detailModule}
            patientClaims={selectedPatientClaims}
            detailTab={detailTab}
            setDetailTab={setDetailTab}
            setQueueOpen={setQueueOpen}
            access={access}
            notify={notify}
            captureBiometric={captureBiometric}
            submitClaimToSwitch={submitClaimToSwitch}
            prepareEmailClaimForm={prepareEmailClaimForm}
            saveEmailClaimPreparation={saveEmailClaimPreparation}
            sendClaimForClientAuthentication={sendClaimForClientAuthentication}
            authenticateEmailClaim={authenticateEmailClaim}
            submitEmailClaim={submitEmailClaim}
            recordAdjudication={recordAdjudication}
            proposePatientResponsibility={proposePatientResponsibility}
            rejectionReasons={REJECTION_REASONS}
          />
        ) : (
          <EmptyState title={`No claims in ${module.label}`} detail="Change module, search, or reset filters to find the claim you need." />
        )}
      </div>
    </div>
  );
}

function ModuleNav({ activeModule, counts, onSelect }) {
  return (
    <StickyBar label="Claims modules">
      <nav className="flex gap-1 overflow-x-auto">
        {MODULES.map((module) => {
          const active = activeModule === module.id;
          return (
            <button
              key={module.id}
              type="button"
              onClick={() => onSelect(module.id)}
              title={module.detail}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex h-control-sm shrink-0 items-center gap-2 rounded-sm px-3 text-small font-medium transition duration-fast ${active ? 'bg-brand/[0.08] text-brand-deep shadow-nav-active' : 'text-body hover:bg-ink/[0.04] hover:text-ink'}`}
            >
              <span>{module.label}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-xs tnum leading-none ${active ? 'bg-brand/10 text-brand-deep' : 'bg-ink/[0.05] text-muted'}`}>{counts[module.id] ?? 0}</span>
            </button>
          );
        })}
      </nav>
    </StickyBar>
  );
}

function ClaimsQueue({ claims, selectedClaim, queueOpen, setQueueOpen, onSelect }) {
  return (
    <section className={`${queueOpen ? 'block' : 'hidden xl:block'} lh-card-pad space-y-3 xl:lh-sticky-panel`}>
      {queueOpen ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Work queue</p>
              <p className="text-xs text-body">{claims.length} claims in this module</p>
            </div>
            {selectedClaim ? (
              <button type="button" onClick={() => setQueueOpen(false)} className="lh-icon-button" aria-label="Collapse queue">
                <ChevronLeft size={16} />
              </button>
            ) : null}
          </div>

          <div className="max-h-[680px] space-y-2 overflow-y-auto pr-1 xl:max-h-none xl:overflow-visible">
            {claims.length ? claims.map((claim) => (
              <ClaimQueueItem key={claim.id} claim={claim} selected={selectedClaim?.id === claim.id} onSelect={() => onSelect(claim)} />
            )) : (
              <div className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-body">
                No claims match this module and filter set.
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <button type="button" onClick={() => setQueueOpen(true)} className="lh-icon-button" aria-label="Show queue">
            <ArrowLeft size={16} />
          </button>
          <div className="flex max-h-[620px] flex-col gap-2 overflow-hidden">
            {claims.slice(0, 8).map((claim) => (
              <button
                key={claim.id}
                type="button"
                title={`${claim.patient} | ${claim.id}`}
                onClick={() => onSelect(claim)}
                className={`grid h-11 w-11 place-items-center rounded-lg border text-xs font-semibold transition ${selectedClaim?.id === claim.id ? 'border-teal bg-teal-soft text-teal-deep' : 'border-line bg-white text-body hover:border-teal/50'}`}
              >
                {claim.patient?.split(' ').map((part) => part[0]).join('').slice(0, 2) || 'CL'}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ClaimQueueItem({ claim, selected, onSelect }) {
  const blockers = blockerCount(claim);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition ${selected ? 'border-teal bg-teal-soft/70 shadow-sm' : 'border-line bg-white hover:border-teal/50 hover:bg-teal-soft/30'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{claim.patient}</p>
          <p className="mt-0.5 truncate text-xs text-body">{claim.id} | {claim.invoice || 'No invoice'} | {displayCopy(claim.memberNo || 'No member')}</p>
        </div>
        <StatusPill label={claim.status} tone={claimStatusTone[claim.status]} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <span className="truncate text-body">{claim.plan || claim.payerName || 'No payer'}</span>
        <span className="text-right font-semibold text-ink">{claimAmount(claim)}</span>
        <span className={blockers ? 'font-medium text-danger' : 'text-muted'}>{blockers ? `${blockers} blocker${blockers === 1 ? '' : 's'}` : 'No blockers'}</span>
        <span className="text-right text-muted">{claim.ageDays == null ? 'No age' : `${claim.ageDays}d old`}</span>
      </div>
    </button>
  );
}

const editablePreparationStatuses = new Set(['Draft', 'Ready', 'Validation failed', 'Ready for submission', 'Requires action', 'Failed']);

const emptyDiagnosis = () => ({ code: '', description: '', kind: 'secondary' });

function draftFromPreparation(context) {
  const claim = context.claim;
  const attachedByDocument = new Map((claim.attachments || []).map((item) => [item.document_id, item]));
  return {
    encounterId: claim.encounter_id || '',
    membershipNumber: claim.membership_number || context.patient?.member_number || '',
    memberSuffix: claim.member_suffix || context.patient?.member_suffix || context.patient?.dependant_code || '',
    relationshipToMember: claim.relationship_to_member || context.patient?.relationship_to_member || '',
    serviceFromDate: claim.service_from_date || '',
    serviceToDate: claim.service_to_date || claim.service_from_date || '',
    notes: claim.notes || '',
    diagnoses: (claim.diagnoses || []).map((item) => ({
      code: item.code || '', description: item.description || '', kind: item.kind || 'secondary',
    })),
    lines: (claim.lines || []).map((line) => ({
      id: line.id,
      tariffCode: line.tariff_code || '',
      tariffDescription: line.tariff_description || '',
      practitionerId: line.practitioner_id || '',
      serviceDate: line.service_date || claim.service_from_date || '',
      claimedAmount: Number(line.claimed_amount || 0),
    })),
    attachments: (context.documents || []).filter((document) => document.attached).map((document) => {
      const attached = attachedByDocument.get(document.id) || {};
      return {
        documentId: document.id,
        attachmentType: attached.attachment_type || 'clinical_support',
        reason: attached.reason || 'Selected during claim preparation',
      };
    }),
  };
}

function preparationChecks(context, draft) {
  if (!context || !draft) return [];
  const patient = context.patient || {};
  const selectedEncounter = context.encounters.find((item) => item.id === draft.encounterId);
  return [
    { label: 'Patient name', complete: Boolean(patient.full_name), detail: patient.full_name || 'Missing from patient file', required: true },
    { label: 'Date of birth', complete: Boolean(patient.date_of_birth), detail: patient.date_of_birth || 'Missing from patient file', required: true },
    { label: 'Sex', complete: Boolean(patient.sex), detail: patient.sex || 'Missing from patient file', required: true },
    { label: 'Medical aid', complete: Boolean(patient.scheme_name && patient.payer_name), detail: patient.scheme_name || 'No active scheme', required: true },
    { label: 'Member number', complete: Boolean(draft.membershipNumber.trim()), detail: draft.membershipNumber || 'Required', required: true },
    { label: 'Service date', complete: Boolean(draft.serviceFromDate), detail: draft.serviceFromDate || 'Required', required: true },
    { label: 'Source encounter', complete: Boolean(selectedEncounter), detail: selectedEncounter ? `${selectedEncounter.note_type} | ${selectedEncounter.status}` : 'Choose the encounter for this claim', required: true },
    { label: 'Signed encounter', complete: Boolean(selectedEncounter && ['signed', 'amended'].includes(String(selectedEncounter.status).toLowerCase())), detail: selectedEncounter?.signed_at ? `Signed ${String(selectedEncounter.signed_at).slice(0, 10)}` : 'Encounter must be signed', required: true },
    { label: 'Primary diagnosis', complete: draft.diagnoses.some((item) => item.kind === 'primary' && item.code.trim()), detail: 'At least one primary ICD-10 code', required: true },
    { label: 'Claim lines', complete: draft.lines.length > 0, detail: `${draft.lines.length} line${draft.lines.length === 1 ? '' : 's'}`, required: true },
    { label: 'Tariff codes', complete: draft.lines.length > 0 && draft.lines.every((item) => item.tariffCode.trim()), detail: 'Every line needs a tariff code', required: true },
    { label: 'Treating providers', complete: draft.lines.length > 0 && draft.lines.every((item) => item.practitionerId), detail: 'Recommended on every line', required: false },
    { label: 'Supporting documents', complete: draft.attachments.length > 0, detail: draft.attachments.length ? `${draft.attachments.length} selected` : 'Add only documents relevant to the claim', required: false },
  ];
}

function ClaimPreparationWorkspace({ claim, access, notify, reloadWorkspace, setQueueOpen }) {
  const [context, setContext] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [validation, setValidation] = useState(null);
  const apiId = claim.apiId;

  const load = async () => {
    if (!apiId) return;
    setLoading(true);
    setLoadError('');
    try {
      const next = await api.claims.preparationContext(apiId);
      setContext(next);
      setDraft(draftFromPreparation(next));
      setValidation(next.claim.validation_result || null);
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!apiId) return undefined;
    setLoading(true);
    api.claims.preparationContext(apiId).then((next) => {
      if (!active) return;
      setContext(next);
      setDraft(draftFromPreparation(next));
      setValidation(next.claim.validation_result || null);
      setLoadError('');
    }).catch((error) => {
      if (active) setLoadError(error.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [apiId]);

  const checks = useMemo(() => preparationChecks(context, draft), [context, draft]);
  const requiredRemaining = checks.filter((item) => item.required && !item.complete).length;
  const editable = access.can.editClaims && editablePreparationStatuses.has(claim.status);

  const setField = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  const updateDiagnosis = (index, key, value) => setDraft((current) => ({
    ...current,
    diagnoses: current.diagnoses.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item),
  }));
  const updateLine = (index, key, value) => setDraft((current) => ({
    ...current,
    lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item),
  }));

  const chooseEncounter = (event) => {
    const encounterId = event.target.value;
    const encounter = context.encounters.find((item) => item.id === encounterId);
    setDraft((current) => ({
      ...current,
      encounterId,
      serviceFromDate: current.serviceFromDate || String(encounter?.created_at || '').slice(0, 10),
      serviceToDate: current.serviceToDate || String(encounter?.created_at || '').slice(0, 10),
    }));
  };

  const importEncounterDiagnoses = () => {
    const encounter = context.encounters.find((item) => item.id === draft.encounterId);
    const diagnoses = Array.isArray(encounter?.diagnoses) ? encounter.diagnoses : [];
    if (!diagnoses.length) {
      notify('The selected encounter has no diagnoses to import');
      return;
    }
    setDraft((current) => ({
      ...current,
      diagnoses: diagnoses.map((item, index) => ({
        code: item.code || '', description: item.label || item.description || '', kind: index === 0 ? 'primary' : 'secondary',
      })),
    }));
  };

  const toggleDocument = (document) => setDraft((current) => {
    const selected = current.attachments.some((item) => item.documentId === document.id);
    return {
      ...current,
      attachments: selected
        ? current.attachments.filter((item) => item.documentId !== document.id)
        : [...current.attachments, { documentId: document.id, attachmentType: 'clinical_support', reason: 'Selected during claim preparation' }],
    };
  });

  const save = async (checkReadiness) => {
    setSaving(true);
    try {
      await api.claims.savePreparation(apiId, {
        encounterId: draft.encounterId || null,
        membershipNumber: draft.membershipNumber,
        memberSuffix: draft.memberSuffix || null,
        relationshipToMember: draft.relationshipToMember || null,
        serviceFromDate: draft.serviceFromDate,
        serviceToDate: draft.serviceToDate || draft.serviceFromDate,
        notes: draft.notes || null,
        diagnoses: draft.diagnoses.filter((item) => item.code.trim()).map((item) => ({
          code: item.code, description: item.description, kind: item.kind,
        })),
        lines: draft.lines.map((line) => ({
          id: line.id,
          tariffCode: line.tariffCode,
          tariffDescription: line.tariffDescription,
          practitionerId: line.practitionerId || null,
          serviceDate: line.serviceDate || draft.serviceFromDate,
        })),
        attachments: draft.attachments,
      });
      let result = null;
      if (checkReadiness) result = await api.claims.validate(apiId);
      setValidation(result);
      await reloadWorkspace?.();
      await load();
      notify(checkReadiness
        ? result.valid ? `${claim.id} preparation is complete` : `${claim.id} still needs ${result.errors.length} correction${result.errors.length === 1 ? '' : 's'}`
        : `${claim.id} preparation saved`);
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <section className="lh-card-pad min-h-[320px] animate-pulse text-sm text-body">Loading claim preparation...</section>;
  if (loadError || !context || !draft) return (
    <section className="lh-card-pad">
      <p className="text-sm font-semibold text-danger">Claim preparation could not be loaded</p>
      <p className="mt-1 text-sm text-body">{loadError || 'No preparation context was returned.'}</p>
      <button type="button" onClick={load} className="lh-secondary-button mt-4">Try again</button>
    </section>
  );

  const patient = context.patient || {};
  const selectedEncounter = context.encounters.find((item) => item.id === draft.encounterId);
  const coverProblem = patient.cover_status && !String(patient.cover_status).toLowerCase().startsWith('active');

  return (
    <section className="lh-card min-w-0 overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-line px-4 py-4 sm:px-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <button type="button" onClick={() => setQueueOpen(true)} className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-teal xl:hidden"><ChevronLeft size={14} />Queue</button>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label="Preparation" tone="accent" />
            <StatusPill label={claim.status} tone={claimStatusTone[claim.status]} />
            <StatusPill label={requiredRemaining ? `${requiredRemaining} required` : 'Required information complete'} tone={requiredRemaining ? 'alert' : 'success'} />
          </div>
          <h2 className="mt-3 truncate text-xl font-semibold text-ink">{patient.full_name || claim.patient}</h2>
          <p className="mt-1 text-sm text-body">{claim.id} | {claim.invoice || 'No invoice'} | {claimAmount(claim)}</p>
        </div>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={saving} onClick={() => save(false)} className="lh-secondary-button"><Save size={15} />Save draft</button>
            <button type="button" disabled={saving || requiredRemaining > 0} onClick={() => save(true)} className="lh-primary-button disabled:cursor-not-allowed disabled:opacity-50"><CheckCircle2 size={15} />Save and check readiness</button>
          </div>
        ) : <p className="text-xs font-medium text-body">Read-only at this claim status</p>}
      </div>

      <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 divide-y divide-line">
          <PreparationSection title="Patient and cover" detail="Current patient-file information used to identify the member.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ReadOnlyField label="Patient" value={patient.full_name} />
              <ReadOnlyField label="Date of birth" value={patient.date_of_birth} />
              <ReadOnlyField label="Sex" value={patient.sex} />
              <ReadOnlyField label="National ID" value={patient.national_id || 'Not recorded'} />
              <ReadOnlyField label="Scheme" value={patient.scheme_name || 'Not recorded'} alert={!patient.scheme_name} />
              <ReadOnlyField label="Payer" value={patient.payer_name || 'Not recorded'} alert={!patient.payer_name} />
            </div>
            {coverProblem ? <p className="mt-3 flex items-center gap-2 text-sm text-danger"><AlertTriangle size={15} />Cover status is {patient.cover_status}. Confirm eligibility before completing the claim.</p> : null}
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <PreparationField label="Member number" required><input disabled={!editable} value={draft.membershipNumber} onChange={setField('membershipNumber')} className="lh-input" /></PreparationField>
              <PreparationField label="Member suffix"><input disabled={!editable} value={draft.memberSuffix} onChange={setField('memberSuffix')} className="lh-input" /></PreparationField>
              <PreparationField label="Relationship to member"><input disabled={!editable} value={draft.relationshipToMember} onChange={setField('relationshipToMember')} className="lh-input" /></PreparationField>
            </div>
          </PreparationSection>

          <PreparationSection title="Encounter and service dates" detail="Choose the clinical source; only its diagnosis codes are copied into the claim.">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_170px_170px]">
              <PreparationField label="Source encounter" required>
                <select disabled={!editable} value={draft.encounterId} onChange={chooseEncounter} className="lh-input">
                  <option value="">Choose encounter</option>
                  {context.encounters.map((encounter) => <option key={encounter.id} value={encounter.id}>{String(encounter.created_at).slice(0, 10)} | {encounter.note_type} | {encounter.provider_name} | {encounter.status}</option>)}
                </select>
              </PreparationField>
              <PreparationField label="From" required><input disabled={!editable} type="date" value={draft.serviceFromDate} onChange={setField('serviceFromDate')} className="lh-input" /></PreparationField>
              <PreparationField label="To"><input disabled={!editable} type="date" value={draft.serviceToDate} onChange={setField('serviceToDate')} className="lh-input" /></PreparationField>
            </div>
            {selectedEncounter && !['signed', 'amended'].includes(String(selectedEncounter.status).toLowerCase()) ? <p className="mt-3 flex items-center gap-2 text-sm text-danger"><AlertTriangle size={15} />This encounter is not signed.</p> : null}
          </PreparationSection>

          <PreparationSection title="Diagnoses" detail="The primary diagnosis explains the services being claimed.">
            <div className="mb-3 flex flex-wrap gap-2">
              <button type="button" disabled={!editable || !draft.encounterId} onClick={importEncounterDiagnoses} className="lh-secondary-button">Use encounter diagnoses</button>
              <button type="button" disabled={!editable} onClick={() => setDraft((current) => ({ ...current, diagnoses: [...current.diagnoses, emptyDiagnosis()] }))} className="lh-secondary-button"><Plus size={15} />Add diagnosis</button>
            </div>
            <div className="space-y-2">
              {draft.diagnoses.map((diagnosis, index) => (
                <div key={`${index}-${diagnosis.code}`} className="grid gap-2 sm:grid-cols-[120px_150px_minmax(0,1fr)_36px]">
                  <input disabled={!editable} value={diagnosis.code} onChange={(event) => updateDiagnosis(index, 'code', event.target.value.toUpperCase())} placeholder="ICD-10" className="lh-input" />
                  <select disabled={!editable} value={diagnosis.kind} onChange={(event) => updateDiagnosis(index, 'kind', event.target.value)} className="lh-input"><option value="primary">Primary</option><option value="secondary">Secondary</option></select>
                  <input disabled={!editable} value={diagnosis.description} onChange={(event) => updateDiagnosis(index, 'description', event.target.value)} placeholder="Diagnosis description" className="lh-input" />
                  <button type="button" disabled={!editable} onClick={() => setDraft((current) => ({ ...current, diagnoses: current.diagnoses.filter((_, itemIndex) => itemIndex !== index) }))} className="lh-icon-button" aria-label="Remove diagnosis"><X size={15} /></button>
                </div>
              ))}
              {!draft.diagnoses.length ? <p className="rounded-lg border border-dashed border-line p-4 text-sm text-body">No diagnoses attached to this claim.</p> : null}
            </div>
          </PreparationSection>

          <PreparationSection title="Claim lines" detail="Confirm the tariff and treating provider for every invoiced service.">
            <div className="space-y-3">
              {draft.lines.map((line, index) => (
                <div key={line.id} className="grid gap-3 border-b border-line pb-3 last:border-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_150px_220px_140px]">
                  <div><p className="text-sm font-semibold text-ink">{line.tariffDescription || `Service line ${index + 1}`}</p><p className="mt-1 text-xs text-body">Claimed {claim.currency || 'USD'} {line.claimedAmount.toFixed(2)}</p></div>
                  <PreparationField label="Tariff code" required><input disabled={!editable} value={line.tariffCode} onChange={(event) => updateLine(index, 'tariffCode', event.target.value)} className="lh-input" /></PreparationField>
                  <PreparationField label="Treating provider"><select disabled={!editable} value={line.practitionerId} onChange={(event) => updateLine(index, 'practitionerId', event.target.value)} className="lh-input"><option value="">Not recorded</option>{context.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.display_name}{provider.registration_number ? ` | ${provider.registration_number}` : ''}</option>)}</select></PreparationField>
                  <PreparationField label="Service date"><input disabled={!editable} type="date" value={line.serviceDate} onChange={(event) => updateLine(index, 'serviceDate', event.target.value)} className="lh-input" /></PreparationField>
                </div>
              ))}
            </div>
          </PreparationSection>

          <PreparationSection title="Supporting documents" detail="Select only documents necessary to support this claim.">
            <div className="space-y-2">
              {context.documents.map((document) => {
                const attachment = draft.attachments.find((item) => item.documentId === document.id);
                return (
                  <div key={document.id} className="grid gap-2 border-b border-line py-2 first:pt-0 last:border-0 sm:grid-cols-[minmax(0,1fr)_190px]">
                    <label className="flex min-w-0 items-start gap-3">
                      <input disabled={!editable} type="checkbox" checked={Boolean(attachment)} onChange={() => toggleDocument(document)} className="mt-1 h-4 w-4 accent-teal" />
                      <span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{document.filename}</span><span className="text-xs text-body">{document.kind} | {String(document.created_at).slice(0, 10)}</span></span>
                    </label>
                    {attachment ? <select disabled={!editable} value={attachment.attachmentType} onChange={(event) => setDraft((current) => ({ ...current, attachments: current.attachments.map((item) => item.documentId === document.id ? { ...item, attachmentType: event.target.value } : item) }))} className="lh-input"><option value="clinical_support">Clinical support</option><option value="prescription">Prescription</option><option value="laboratory_request">Laboratory request</option><option value="radiology_request">Radiology request</option><option value="referral">Referral</option><option value="hospital_breakdown">Hospital breakdown</option><option value="discharge_document">Discharge document</option><option value="other">Other</option></select> : null}
                  </div>
                );
              })}
              {!context.documents.length ? <p className="rounded-lg border border-dashed border-line p-4 text-sm text-body">No patient documents are available to attach.</p> : null}
            </div>
          </PreparationSection>

          <PreparationSection title="Internal preparation note" detail="Visible to claim staff; not part of the patient-facing invoice.">
            <textarea disabled={!editable} value={draft.notes} onChange={setField('notes')} rows={3} maxLength={1000} className="lh-input h-auto py-2" />
          </PreparationSection>
        </div>

        <aside className="border-t border-line bg-surface/45 p-4 xl:border-l xl:border-t-0">
          <div className="xl:sticky xl:top-4">
            <p className="text-sm font-semibold text-ink">Preparation readiness</p>
            <p className="mt-1 text-xs text-body">Required information must be complete before validation.</p>
            <div className="mt-4 space-y-3">
              {checks.map((item) => (
                <div key={item.label} className="flex gap-2.5">
                  {item.complete ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" /> : <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${item.required ? 'text-danger' : 'text-warning'}`} />}
                  <div><p className="text-xs font-semibold text-ink">{item.label}{!item.required ? ' (recommended)' : ''}</p><p className="mt-0.5 text-xs text-body">{item.detail}</p></div>
                </div>
              ))}
            </div>
            {validation?.errors?.length ? (
              <div className="mt-5 border-t border-line pt-4"><p className="text-xs font-semibold text-danger">Server validation</p>{validation.errors.map((item) => <p key={`${item.code}-${item.field}`} className="mt-2 text-xs text-body">{item.message}</p>)}</div>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
}

function PreparationSection({ title, detail, children }) {
  return <section className="px-4 py-5 sm:px-5"><h3 className="text-sm font-semibold text-ink">{title}</h3><p className="mt-1 text-xs text-body">{detail}</p><div className="mt-4">{children}</div></section>;
}

function PreparationField({ label, required = false, children }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-ink">{label}{required ? <span className="ml-1 text-danger">*</span> : null}</span>{children}</label>;
}

function ReadOnlyField({ label, value, alert = false }) {
  return <div className="min-w-0"><p className="text-xs text-muted">{label}</p><p className={`mt-1 truncate text-sm font-medium ${alert ? 'text-danger' : 'text-ink'}`}>{value || 'Not recorded'}</p></div>;
}

function ClaimModuleDetail({
  claim,
  module,
  patientClaims,
  detailTab,
  setDetailTab,
  setQueueOpen,
  access,
  notify,
  captureBiometric,
  submitClaimToSwitch,
  prepareEmailClaimForm,
  saveEmailClaimPreparation,
  sendClaimForClientAuthentication,
  authenticateEmailClaim,
  submitEmailClaim,
  recordAdjudication,
  proposePatientResponsibility,
  rejectionReasons,
}) {
  const blockers = blockerCount(claim);
  const channel = claim.submissionChannel || claim.channel || 'Manual';
  const attachments = claim.attachments || [];
  const lines = claim.lines || claim.services || [];
  const events = claim.events?.length ? claim.events : claim.responses || [];
  const memberLiability = moneyNumber(claim, 'memberLiability', moneyNumber(claim, 'patientResponsibility'));
  const insurerLiability = moneyNumber(claim, 'insurerLiability', moneyNumber(claim, 'approvedAmount', moneyNumber(claim, 'claimed')));

  return (
    <section className="lh-card-pad min-w-0 space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <button type="button" onClick={() => setQueueOpen(true)} className="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-teal xl:hidden">
            <ChevronLeft size={14} />Queue
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={module.label} tone="accent" />
            <StatusPill label={claim.status} tone={claimStatusTone[claim.status]} />
            <StatusPill label={channel} tone="neutral" />
            {blockers ? <StatusPill label={`${blockers} blockers`} tone="alert" /> : <StatusPill label="Clean validation" tone="success" />}
          </div>
          <h2 className="mt-3 truncate text-2xl font-semibold tracking-title text-ink">{claim.patient}</h2>
          <p className="mt-1 text-sm text-body">{claim.id} | {claim.invoice || 'No invoice'} | {displayCopy(claim.memberNo || 'No member number')}</p>
        </div>
        <ModuleActions
          claim={claim}
          moduleId={module.id}
          access={access}
          notify={notify}
          captureBiometric={captureBiometric}
          submitClaimToSwitch={submitClaimToSwitch}
          prepareEmailClaimForm={prepareEmailClaimForm}
          sendClaimForClientAuthentication={sendClaimForClientAuthentication}
          authenticateEmailClaim={authenticateEmailClaim}
          submitEmailClaim={submitEmailClaim}
          recordAdjudication={recordAdjudication}
          proposePatientResponsibility={proposePatientResponsibility}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SummaryTile label="Claimed" value={claimAmount(claim)} detail={claim.tariff || 'Claim total'} tone="neutral" />
        <SummaryTile label="Approved" value={`USD ${moneyNumber(claim, 'approvedAmount').toFixed(2)}`} detail="Funder approved" tone={moneyNumber(claim, 'approvedAmount') > 0 ? 'success' : 'neutral'} />
        <SummaryTile label="Insurer pays" value={`USD ${insurerLiability.toFixed(2)}`} detail={claim.plan || claim.payerName || 'No payer'} tone="accent" />
        <SummaryTile label="Patient pays" value={`USD ${memberLiability.toFixed(2)}`} detail={memberLiability > 0 ? 'Collectable balance' : 'No member portion'} tone={memberLiability > 0 ? 'warm' : 'success'} />
      </div>

      <div className="lh-tabs" role="tablist" aria-label="Claim detail">
        {module.detailTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setDetailTab(tab)}
            role="tab"
            aria-selected={detailTab === tab}
            className="lh-tab"
          >
            {tab}
          </button>
        ))}
      </div>

      {detailTab === 'Summary' ? (
        <SummaryPanel claim={claim} patientClaims={patientClaims} />
      ) : null}
      {detailTab === 'Coding' ? (
        <CodingPanel claim={claim} />
      ) : null}
      {detailTab === 'Validation' ? (
        <IssueList claim={claim} />
      ) : null}
      {detailTab === 'Submission' ? (
        <SubmissionPanel claim={claim} access={access} captureBiometric={captureBiometric} submitClaimToSwitch={submitClaimToSwitch} />
      ) : null}
      {detailTab === 'Email pack' ? (
        <EmailPackPanel
          claim={claim}
          prepareEmailClaimForm={prepareEmailClaimForm}
          saveEmailClaimPreparation={saveEmailClaimPreparation}
          sendClaimForClientAuthentication={sendClaimForClientAuthentication}
          authenticateEmailClaim={authenticateEmailClaim}
          submitEmailClaim={submitEmailClaim}
        />
      ) : null}
      {detailTab === 'Timeline' ? (
        <TimelinePanel claim={claim} events={events} />
      ) : null}
      {detailTab === 'Documents' ? (
        <AttachmentsPanel claim={claim} attachments={attachments} access={access} notify={notify} />
      ) : null}
      {detailTab === 'Lines' ? (
        <LinesPanel claim={claim} lines={lines} />
      ) : null}
      {detailTab === 'Adjudication' ? (
        <AdjudicationPanel claim={claim} insurerLiability={insurerLiability} memberLiability={memberLiability} rejectionReasons={rejectionReasons} />
      ) : null}
    </section>
  );
}

function ModuleActions({
  claim,
  moduleId,
  access,
  notify,
  captureBiometric,
  submitClaimToSwitch,
  prepareEmailClaimForm,
  sendClaimForClientAuthentication,
  authenticateEmailClaim,
  submitEmailClaim,
  recordAdjudication,
  proposePatientResponsibility,
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {moduleId === 'prepare' && claim.status === 'Draft' && access.can.captureBiometric ? (
        <ActionButton onClick={() => captureBiometric(claim.id)} icon={Fingerprint}>Capture</ActionButton>
      ) : null}
      {moduleId === 'prepare' && (claim.submissionChannel || claim.channel) !== 'Email' ? (
        <ActionButton onClick={() => prepareEmailClaimForm(claim.id)} icon={Mail}>Email route</ActionButton>
      ) : null}
      {moduleId === 'submit' && READY_STATUSES.has(claim.status) && access.can.submitClaims ? (
        <ActionButton onClick={() => submitClaimToSwitch(claim.id)} icon={UploadCloud}>Submit</ActionButton>
      ) : null}
      {moduleId === 'email' && claim.status === 'Form prepared' ? (
        <ActionButton onClick={() => sendClaimForClientAuthentication(claim.id)} icon={Send}>Send to client</ActionButton>
      ) : null}
      {moduleId === 'email' && claim.status === 'Awaiting client authentication' ? (
        <ActionButton onClick={() => authenticateEmailClaim(claim.id)} icon={ShieldCheck}>Authenticate</ActionButton>
      ) : null}
      {moduleId === 'email' && claim.status === 'Client authenticated' ? (
        <ActionButton onClick={() => submitEmailClaim(claim.id)} icon={Mail}>Email submit</ActionButton>
      ) : null}
      {moduleId === 'track' && IN_FLIGHT_STATUSES.has(claim.status) && access.can.refreshClaimStatus ? (
        <ActionButton onClick={() => notify(`${claim.id} status refresh queued`)} icon={RefreshCw}>Refresh</ActionButton>
      ) : null}
      {moduleId === 'track' && IN_FLIGHT_STATUSES.has(claim.status) && access.can.submitClaims ? (
        <>
          <ActionButton onClick={() => recordAdjudication(claim.id, 'Approved')} icon={CheckCircle2}>Approve</ActionButton>
          <ActionButton onClick={() => recordAdjudication(claim.id, 'Rejected', 'R204')} icon={X}>Reject</ActionButton>
        </>
      ) : null}
      {moduleId === 'resolve' && claim.status === 'Rejected' && !claim.movedToPatient && access.can.createInvoice ? (
        <ActionButton onClick={() => proposePatientResponsibility(claim)} icon={ArrowUpRight}>Patient debt</ActionButton>
      ) : null}
      {moduleId === 'remit' ? (
        <ActionButton onClick={() => notify(`${claim.id} remittance posting flow coming soon`)} icon={FileCheck2}>Post</ActionButton>
      ) : null}
    </div>
  );
}

function SummaryPanel({ claim, patientClaims }) {
  return (
    <div className="grid min-w-0 items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
      <InfoList
        title="Member and claim context"
        rows={[
          ['Member number', displayCopy(claim.memberNo || 'Missing')],
          ['Eligibility', claim.eligibility || 'Not checked'],
          ['Biometric', claim.biometric || 'Not captured'],
          ['Service date', claim.serviceDate || claim.createdAt || 'Missing'],
          ['Provider', claim.provider || 'Unassigned'],
          ['External ref', claim.externalReference || 'Not submitted'],
          ['Diagnosis', claim.icd10 || 'Not coded'],
          ['Tariff', claim.tariff || 'No tariff lines'],
        ]}
      />
      <div className="lh-side-panel rounded-lg border border-line bg-white p-4">
        <p className="text-sm font-semibold text-ink">Patient claim history</p>
        <div className="mt-3 space-y-2">
          {patientClaims.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-ink">{item.id}</p>
                <p className="truncate text-2xs text-body">{item.invoice || 'No invoice'} | {item.serviceDate || 'No date'}</p>
              </div>
              <StatusPill label={item.status} tone={claimStatusTone[item.status]} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CodingPanel({ claim }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InfoList
        title="Coding readiness"
        rows={[
          ['Diagnosis', claim.icd10 || 'Not coded'],
          ['Tariff', claim.tariff || 'Missing'],
          ['Provider', claim.provider || 'Unassigned'],
          ['Blockers', blockerCount(claim)],
        ]}
      />
      <div className="rounded-lg bg-surface/60 p-4">
        <p className="text-sm font-semibold text-ink">Preparation checklist</p>
        <div className="mt-3 space-y-2 text-sm">
          <ChecklistItem done={Boolean(claim.icd10 && claim.icd10 !== 'Not coded')} label="Diagnosis code captured" />
          <ChecklistItem done={Boolean(claim.tariff)} label="Tariff line present" />
          <ChecklistItem done={Boolean(claim.memberNo)} label="Member number present" />
          <ChecklistItem done={Boolean(claim.biometric && claim.biometric !== 'Not captured')} label="Biometric captured where required" />
        </div>
      </div>
    </div>
  );
}

function SubmissionPanel({ claim, access, captureBiometric, submitClaimToSwitch }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InfoList
        title="Submission package"
        rows={[
          ['Channel', claim.submissionChannel || claim.channel || 'Manual'],
          ['Member', displayCopy(claim.memberNo || 'Missing')],
          ['Biometric', claim.biometric || 'Not captured'],
          ['Payload ref', claim.externalReference || 'Not submitted'],
        ]}
      />
      <div className="rounded-lg bg-surface/60 p-4">
        <p className="text-sm font-semibold text-ink">Next action</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {claim.status === 'Draft' && access.can.captureBiometric ? (
            <ActionButton onClick={() => captureBiometric(claim.id)} icon={Fingerprint}>Capture biometric</ActionButton>
          ) : null}
          {READY_STATUSES.has(claim.status) && access.can.submitClaims ? (
            <ActionButton onClick={() => submitClaimToSwitch(claim.id)} icon={UploadCloud}>Submit to switch</ActionButton>
          ) : (
            <p className="text-sm text-body">This claim is not currently in a submit-ready state.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function EmailPackPanel({
  claim,
  prepareEmailClaimForm,
  saveEmailClaimPreparation,
  sendClaimForClientAuthentication,
  authenticateEmailClaim,
  submitEmailClaim,
}) {
  const makeDraft = (sourceClaim) => {
    const existing = sourceClaim.emailSubmission || {};
    const payer = sourceClaim.plan || sourceClaim.payerName || 'International insurer';
    const serviceDate = sourceClaim.serviceDate || 'the recorded service date';
    const memberEnding = sourceClaim.memberNo ? String(sourceClaim.memberNo).slice(-4) : 'pending';
    return {
      providerEmail: existing.providerEmail || '',
      memberEmail: existing.memberEmail || '',
      claimForm: existing.claimForm || `${payer} claim form`,
      followUpDays: String(existing.followUpDays || 3),
      memberSubject: existing.memberSubject || `Action required: review claim ${sourceClaim.id}`,
      memberBody: existing.memberBody || `Hello ${sourceClaim.patient},\n\nLuminary Health has prepared a medical claim relating to your visit on ${serviceDate}.\n\nPlease review the claim using the secure link below and authorise its submission using the one-time code sent to you.\n\n[Review and authorise claim]\n\nThis link expires in 48 hours. Please do not reply to this email with medical information.\n\nLuminary Health`,
      insurerSubject: existing.insurerSubject || existing.subject || `Claim submission | ${sourceClaim.id} | Member ending ${memberEnding}`,
      insurerBody: existing.insurerBody || `Dear Claims Team,\n\nPlease find attached an authorised medical claim submitted by Luminary Health.\n\nPractice: Luminary Health\nProvider: ${sourceClaim.provider || 'Not assigned'}\nClaim reference: ${sourceClaim.id}\nService date: ${serviceDate}\nClaimed amount: ${claimAmount(sourceClaim)}\n\nPrepared by Luminary Health on behalf of the member and reviewed and authorised by the member before submission.\n\nPlease acknowledge receipt and quote ${sourceClaim.id} in future correspondence.\n\nRegards,\nLuminary Health Claims Team`,
      requiredDocuments: existing.requiredDocuments || ['Claim form', 'Itemised invoice', 'Clinical notes'],
      attachments: existing.attachments || sourceClaim.attachments || ['Claim form draft', `${sourceClaim.invoice || sourceClaim.id} itemised invoice`],
    };
  };

  const [activeEditor, setActiveEditor] = useState('pack');
  const [draft, setDraft] = useState(() => makeDraft(claim));
  const [saved, setSaved] = useState(() => Boolean(claim.emailSubmission?.memberSubject && claim.emailSubmission?.memberBody && claim.emailSubmission?.insurerSubject && claim.emailSubmission?.insurerBody));

  useEffect(() => {
    setDraft(makeDraft(claim));
    setSaved(Boolean(claim.emailSubmission?.memberSubject && claim.emailSubmission?.memberBody && claim.emailSubmission?.insurerSubject && claim.emailSubmission?.insurerBody));
    setActiveEditor('pack');
    // The draft intentionally resets only when another claim is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim.id]);

  const pack = claim.emailSubmission || {};
  const authenticated = claim.status === 'Client authenticated' || claim.status === 'Email submitted';
  const sent = claim.status === 'Email submitted';
  const locked = authenticated || sent;
  const selectedDocument = (document) => draft.attachments.some((attachment) => String(attachment.name || attachment).toLowerCase().includes(document.toLowerCase().split(' ')[0]));
  const missing = [
    !draft.memberEmail.trim() && 'Member email address',
    !draft.providerEmail.trim() && 'Insurer claims email',
    !draft.claimForm.trim() && 'Provider claim form',
    !draft.memberSubject.trim() && 'Member message subject',
    !draft.memberBody.trim() && 'Member message content',
    !draft.insurerSubject.trim() && 'Insurer email subject',
    !draft.insurerBody.trim() && 'Insurer email content',
    ...draft.requiredDocuments.filter((document) => !selectedDocument(document)).map((document) => `${document} attachment`),
  ].filter(Boolean);

  const updateDraft = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
  };

  const toggleDocument = (document) => {
    if (locked) return;
    const included = selectedDocument(document);
    const token = document.toLowerCase().split(' ')[0];
    updateDraft('attachments', included
      ? draft.attachments.filter((attachment) => !String(attachment.name || attachment).toLowerCase().includes(token))
      : [...draft.attachments, document]);
  };

  const saveDraft = () => {
    saveEmailClaimPreparation(claim.id, {
      ...draft,
      subject: draft.insurerSubject,
      followUp: `${draft.followUpDays || 3} business days after submission`,
    });
    setSaved(true);
  };

  const preparePack = () => {
    saveDraft();
    prepareEmailClaimForm(claim.id);
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 border-b border-line pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-semibold text-ink">Email preparation studio</p>
          <p className="mt-1 text-xs text-body">Prepare the member review and insurer submission from one controlled claim pack.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {['pack', 'member', 'insurer'].map((view) => (
            <button key={view} type="button" onClick={() => setActiveEditor(view)} className={`rounded-md px-3 py-2 text-xs font-semibold transition ${activeEditor === view ? 'bg-ink text-white' : 'border border-line bg-white text-body hover:text-ink'}`}>
              {view === 'pack' ? 'Claim pack' : view === 'member' ? 'Member message' : 'Insurer email'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-w-0 items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {activeEditor === 'pack' ? (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <PreparationField label="Member email" required><input type="email" value={draft.memberEmail} disabled={locked} onChange={(event) => updateDraft('memberEmail', event.target.value)} placeholder="member@example.com" className="lh-input disabled:bg-surface" /></PreparationField>
                <PreparationField label="Insurer claims email" required><input type="email" value={draft.providerEmail} disabled={locked} onChange={(event) => updateDraft('providerEmail', event.target.value)} placeholder="claims@insurer.com" className="lh-input disabled:bg-surface" /></PreparationField>
                <PreparationField label="Provider claim form" required><input value={draft.claimForm} disabled={locked} onChange={(event) => updateDraft('claimForm', event.target.value)} className="lh-input disabled:bg-surface" /></PreparationField>
                <PreparationField label="Follow up after"><div className="flex items-center gap-2"><input type="number" min="1" max="30" value={draft.followUpDays} disabled={locked} onChange={(event) => updateDraft('followUpDays', event.target.value)} className="lh-input max-w-24 disabled:bg-surface" /><span className="text-sm text-body">business days</span></div></PreparationField>
              </div>
              <div>
                <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-ink">Required attachments</p><p className="mt-1 text-xs text-body">Select exactly what will be included in the authorised pack.</p></div><StatusPill label={`${draft.attachments.length} selected`} tone="neutral" /></div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {draft.requiredDocuments.map((document) => {
                    const included = selectedDocument(document);
                    return <label key={document} className={`flex min-h-[44px] items-center gap-3 rounded-md border px-3 py-2 text-sm ${included ? 'border-success/30 bg-success-soft text-ink' : 'border-line bg-white text-body'}`}><input type="checkbox" checked={included} disabled={locked} onChange={() => toggleDocument(document)} className="h-4 w-4 accent-teal" /><span>{document}</span>{!included ? <span className="ml-auto text-xs text-danger">Required</span> : null}</label>;
                  })}
                </div>
                {draft.attachments.filter((attachment) => !draft.requiredDocuments.some((document) => String(attachment.name || attachment).toLowerCase().includes(document.toLowerCase().split(' ')[0]))).map((attachment) => <div key={String(attachment.name || attachment)} className="mt-2 flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-ink"><Paperclip size={14} className="text-muted" />{attachment.name || attachment}</div>)}
              </div>
            </div>
          ) : null}

          {activeEditor === 'member' ? <MessageEditor recipient={draft.memberEmail || 'Member email required'} subject={draft.memberSubject} body={draft.memberBody} disabled={locked} onSubjectChange={(value) => updateDraft('memberSubject', value)} onBodyChange={(value) => updateDraft('memberBody', value)} footer="The secure review link is inserted when this message is sent." /> : null}
          {activeEditor === 'insurer' ? <MessageEditor recipient={draft.providerEmail || 'Insurer email required'} subject={draft.insurerSubject} body={draft.insurerBody} disabled={locked} onSubjectChange={(value) => updateDraft('insurerSubject', value)} onBodyChange={(value) => updateDraft('insurerBody', value)} footer={`${draft.attachments.length} attachments will accompany this email after member authorisation.`} /> : null}

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            {!locked ? <button type="button" onClick={saveDraft} disabled={saved} className="lh-secondary-button disabled:cursor-not-allowed disabled:opacity-50"><Save size={15} />{saved ? 'Saved' : 'Save changes'}</button> : <p className="flex items-center gap-2 text-xs font-medium text-body"><ShieldCheck size={15} className="text-success" />Content locked after member authorisation</p>}
            {claim.status === 'Draft' ? <button type="button" onClick={preparePack} disabled={missing.length > 0} className="lh-primary-button disabled:cursor-not-allowed disabled:opacity-50"><FileCheck2 size={15} />Prepare pack</button> : null}
          </div>
        </div>

        <aside className="space-y-4">
          <div className={`rounded-lg border p-4 ${missing.length ? 'border-warning/35 bg-warning-wash' : 'border-success/25 bg-success-soft'}`}>
            <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-ink">Preparation readiness</p><p className="mt-1 text-xs text-body">{missing.length ? `${missing.length} required items remain` : 'Both messages and the pack are complete'}</p></div><StatusPill label={missing.length ? 'Incomplete' : 'Ready'} tone={missing.length ? 'warm' : 'success'} /></div>
            {missing.length ? <ul className="mt-3 space-y-2">{missing.map((item) => <li key={item} className="flex items-center gap-2 text-xs text-body"><AlertTriangle size={13} className="shrink-0 text-warning" />{item}</li>)}</ul> : null}
          </div>

          <div className="rounded-lg border border-line bg-white p-4">
            <p className="text-sm font-semibold text-ink">Claim pack progress</p>
            <div className="mt-3 space-y-2 text-sm">
              <ChecklistItem done={Boolean(pack.claimForm) || claim.status !== 'Draft'} label="Pack prepared" />
              <ChecklistItem done={claim.status !== 'Form prepared' && claim.status !== 'Draft'} label="Member review requested" />
              <ChecklistItem done={authenticated} label="Member authorisation recorded" />
              <ChecklistItem done={sent} label="Insurer email recorded" />
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {claim.status === 'Form prepared' ? <button type="button" onClick={() => sendClaimForClientAuthentication(claim.id)} disabled={missing.length > 0 || !saved} className="lh-primary-button justify-center disabled:cursor-not-allowed disabled:opacity-50"><Send size={15} />Send member review</button> : null}
              {claim.status === 'Awaiting client authentication' ? <ActionButton onClick={() => authenticateEmailClaim(claim.id)} icon={ShieldCheck}>Record authentication</ActionButton> : null}
              {claim.status === 'Client authenticated' ? <ActionButton onClick={() => submitEmailClaim(claim.id)} icon={Mail}>Email insurer</ActionButton> : null}
              {sent ? <p className="rounded-md border border-success/25 bg-success-soft px-3 py-2 text-xs text-success-deep">Submission reference: {claim.externalReference || 'Email message id pending'}</p> : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MessageEditor({ recipient, subject, body, disabled, onSubjectChange, onBodyChange, footer }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.85fr)]">
      <div className="space-y-4">
        <PreparationField label="To"><div className="lh-input flex items-center bg-surface text-body">{recipient}</div></PreparationField>
        <PreparationField label="Subject" required><input value={subject} disabled={disabled} onChange={(event) => onSubjectChange(event.target.value)} className="lh-input disabled:bg-surface" /></PreparationField>
        <PreparationField label="Message" required><textarea value={body} disabled={disabled} onChange={(event) => onBodyChange(event.target.value)} rows={15} className="lh-textarea resize-y disabled:bg-surface" /></PreparationField>
        <p className="text-xs text-body">{footer}</p>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-white">
        <div className="border-b border-line bg-surface/70 px-4 py-3"><p className="text-xs font-semibold text-ink">Email preview</p></div>
        <div className="space-y-3 border-b border-line px-4 py-3 text-xs"><p><span className="text-muted">To:</span> <span className="font-medium text-ink">{recipient}</span></p><p><span className="text-muted">Subject:</span> <span className="font-medium text-ink">{subject || 'Subject required'}</span></p></div>
        <div className="min-h-[320px] whitespace-pre-wrap break-words px-5 py-5 text-sm leading-6 text-body">{body || 'Message content required'}</div>
      </div>
    </div>
  );
}

function LinesPanel({ claim, lines }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <div className="min-w-[720px]">
        <div className="grid grid-cols-[minmax(220px,1fr)_110px_110px_110px_120px] gap-3 border-b border-line bg-cream px-4 py-3 text-caption font-semibold text-muted">
          <span>Service</span><span>Claimed</span><span>Approved</span><span>Rejected</span><span>Status</span>
        </div>
        {lines.length ? lines.map((line, index) => {
          const amounts = lineAmount(line);
          return (
            <div key={line.id || `${line.code || line.desc}-${index}`} className="grid grid-cols-[minmax(220px,1fr)_110px_110px_110px_120px] gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{line.code || line.tariffCode || 'No code'}</p>
                <p className="truncate text-xs text-body">{line.desc || line.description || line.service || claim.tariff || 'Service line'}</p>
              </div>
              <span className="text-body">USD {amounts.claimed.toFixed(2)}</span>
              <span className="text-success">USD {amounts.approved.toFixed(2)}</span>
              <span className={amounts.rejected > 0 ? 'text-danger' : 'text-muted'}>USD {amounts.rejected.toFixed(2)}</span>
              <StatusPill label={line.status || claim.status} tone={claimStatusTone[line.status || claim.status]} />
            </div>
          );
        }) : (
          <div className="p-6 text-sm text-body">No line level claim data is attached yet.</div>
        )}
      </div>
    </div>
  );
}

function TimelinePanel({ claim, events }) {
  const fallback = [{ label: 'Claim created', time: claim.createdAt || claim.serviceDate || 'Draft', tone: 'neutral' }];
  return (
    <div className="space-y-3">
      {(events.length ? events : fallback).map((event, index) => (
        <div key={`${event.label}-${index}`} className="flex gap-3 rounded-lg border border-line bg-white p-3">
          <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${event.tone === 'alert' ? 'bg-danger' : event.tone === 'success' ? 'bg-success' : event.tone === 'warm' ? 'bg-warning' : 'bg-muted'}`} />
          <div>
            <p className="text-sm font-medium text-ink">{event.label || event.type || 'Claim event'}</p>
            <p className="text-xs text-body">{event.time || event.createdAt || 'No timestamp'}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function AttachmentsPanel({ attachments, access, notify }) {
  return (
    <div className="rounded-lg bg-surface/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Claim documents</p>
          <p className="text-xs text-body">Pre-auth, referral letters, lab results, and switch payload evidence.</p>
        </div>
        {access.can.manageClaimAttachments ? <button type="button" onClick={() => notify('Claim attachment upload coming soon')} className="lh-secondary-button"><Paperclip size={15} />Attach</button> : null}
      </div>
      <div className="mt-4 space-y-2">
        {attachments.length ? attachments.map((attachment) => (
          <div key={attachment.id || attachment.name} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm">
            <span className="font-medium text-ink">{attachment.name || attachment.type || 'Attachment'}</span>
            <span className="text-xs text-body">{attachment.status || attachment.createdAt || 'On file'}</span>
          </div>
        )) : (
          <div className="rounded-lg border border-dashed border-line p-6 text-sm text-body">No documents are linked to this claim.</div>
        )}
      </div>
    </div>
  );
}

function AdjudicationPanel({ claim, insurerLiability, memberLiability, rejectionReasons }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InfoList
        title="Switch outcome"
        rows={[
          ['Status', claim.status],
          ['Approved amount', `USD ${moneyNumber(claim, 'approvedAmount').toFixed(2)}`],
          ['Rejected amount', `USD ${moneyNumber(claim, 'rejectedAmount').toFixed(2)}`],
          ['Rejection code', claim.rejectionCode || 'None'],
          ['Reason', claim.rejectionCode ? rejectionReasons?.[claim.rejectionCode] || 'Declined by scheme' : 'None'],
        ]}
      />
      <InfoList
        title="Posting impact"
        rows={[
          ['Invoice', claim.invoice || 'No invoice'],
          ['Scheme liability', `USD ${insurerLiability.toFixed(2)}`],
          ['Patient liability', `USD ${memberLiability.toFixed(2)}`],
          ['Moved to patient', claim.movedToPatient ? 'Yes' : 'No'],
        ]}
      />
    </div>
  );
}

function SummaryTile({ label, value, detail, tone }) {
  // Tone is a small dot beside the label rather than a painted tile: colour
  // marks meaning here, it does not decorate.
  const dots = {
    neutral: 'bg-edge-strong',
    accent: 'bg-teal',
    success: 'bg-success-bright',
    warm: 'bg-warning-bright',
    alert: 'bg-danger-bright',
  };

  return (
    <div className="lh-metric min-w-0">
      <p className="flex items-center gap-2 text-small font-medium text-muted">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dots[tone] || dots.neutral}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-2 truncate text-heading font-semibold tracking-title text-ink tnum">{value}</p>
      <p className="mt-1 truncate text-caption text-muted">{detail}</p>
    </div>
  );
}

function ActionButton({ icon: Icon, children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="lh-secondary-button">
      <Icon size={15} />{children}
    </button>
  );
}

function InfoList({ title, rows }) {
  return (
    <div className="rounded-lg bg-surface/60 p-4">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <dl className="mt-3 divide-y divide-line">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 py-2 text-sm">
            <dt className="text-body">{label}</dt>
            <dd className="min-w-0 truncate font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ChecklistItem({ done, label }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
      {done ? <CheckCircle2 size={15} className="text-success" /> : <Inbox size={15} className="text-muted" />}
      <span className={done ? 'font-medium text-ink' : 'text-body'}>{label}</span>
    </div>
  );
}

function IssueList({ claim }) {
  const issues = [
    ...(claim.validation?.errors || []).map((message) => ({ message, tone: 'alert' })),
    ...(claim.validation?.warnings || []).map((message) => ({ message, tone: 'warm' })),
  ];
  if (!issues.length && claim.icd10 === 'Not coded') {
    issues.push({ message: 'Diagnosis code is missing. The claim cannot be submitted until the encounter is coded.', tone: 'alert' });
  }

  return (
    <div className="space-y-3">
      {issues.length ? issues.map((issue, index) => (
        <div key={`${issue.message}-${index}`} className={`rounded-lg border p-4 ${issue.tone === 'alert' ? 'border-danger/30 bg-danger-soft' : 'border-warning/30 bg-warning-wash'}`}>
          <p className="text-sm font-semibold text-ink">{issue.tone === 'alert' ? 'Blocking issue' : 'Warning'}</p>
          <p className="mt-1 text-sm text-body">{issue.message}</p>
        </div>
      )) : (
        <div className="rounded-lg border border-success/25 bg-success-soft p-4">
          <p className="text-sm font-semibold text-ink">Ready for switch submission</p>
          <p className="mt-1 text-sm text-body">No blocking validation issues are visible on this claim.</p>
        </div>
      )}
    </div>
  );
}
