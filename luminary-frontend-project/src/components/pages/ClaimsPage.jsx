import React, { useMemo, useState } from 'react';
import {
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

const ACTION_STATUSES = new Set(['Validation failed', 'Rejected', 'Requires action', 'Query', 'Failed']);
const PREPARE_STATUSES = new Set(['Draft', 'Validation failed']);
const READY_STATUSES = new Set(['Ready', 'Ready for submission', 'Biometric verified']);
const EMAIL_STATUSES = new Set(['Form prepared', 'Awaiting client authentication', 'Client authenticated', 'Email submitted']);
const IN_FLIGHT_STATUSES = new Set(['Submitted', 'Acknowledged', 'Processing', 'Submitting', 'Email submitted']);
const APPROVED_STATUSES = new Set(['Approved', 'Adjudicated', 'Partially approved']);
const REMITTANCE_STATUSES = new Set(['Remitted']);

const MODULES = [
  {
    id: 'prepare',
    label: 'Prepare',
    detail: 'Clean drafts before they hit the switch.',
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
    practiceClaims,
    selectedClaim,
    setSelectedClaimId,
    captureBiometric,
    submitClaimToSwitch,
    prepareEmailClaimForm,
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
  const [queueOpen, setQueueOpen] = useState(true);

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
    const submit = claimsWithAge.filter(MODULES[1].matches).length;
    const email = claimsWithAge.filter(MODULES[2].matches).length;
    const resolve = claimsWithAge.filter(MODULES[4].matches).length;
    const approved = claimsWithAge
      .filter(MODULES[5].matches)
      .reduce((sum, claim) => sum + moneyNumber(claim, 'approvedAmount', moneyNumber(claim, 'claimed')), 0);
    return { prepare, submit, email, resolve, approved };
  }, [claimsWithAge]);

  const resetFilters = () => {
    setQuery('');
    setPayerFilter('all');
    setChannelFilter('all');
  };

  const selectModule = (id) => {
    const next = MODULES.find((item) => item.id === id) || MODULES[0];
    setActiveModule(id);
    setDetailTab(next.detailTabs[0]);
    setQueueOpen(true);
  };

  if (practiceClaims.length === 0) {
    return (
      <EmptyState
        title="No claims in this practice"
        detail="Claims will appear here after an invoice is prepared for a covered patient."
        action={access.can.createClaims ? <button type="button" onClick={() => notify('Create claim flow coming from invoices')} className="lh-primary-button"><Plus size={16} />Prepare first claim</button> : null}
      />
    );
  }

  return (
    <div className="lh-has-sticky-bar space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-caption font-semibold text-teal">Claims operations across switch and email channels</p>
            <StatusPill label={`${practiceClaims.length} claims`} tone="neutral" />
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-title text-ink sm:text-3xl">Medical aid claims</h1>
          <p className="mt-1 max-w-2xl text-sm text-body">
            Claims is split by job: prepare clean claims, submit verified claims, track payer responses, resolve exceptions, and post remittances.
          </p>
        </div>
        <button type="button" onClick={() => notify('New claim draft opens from an invoice')} className="lh-primary-button self-start">
          <Plus size={16} />New claim
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <SummaryTile label="Prepare" value={totals.prepare} detail="Drafts or coding blockers" tone="neutral" />
        <SummaryTile label="Submit" value={totals.submit} detail="Verified and ready" tone="accent" />
        <SummaryTile label="Email" value={totals.email} detail="Client-assisted claims" tone="warm" />
        <SummaryTile label="Resolve" value={totals.resolve} detail="Queries and rejections" tone="alert" />
        <SummaryTile label="Remit value" value={`USD ${totals.approved.toFixed(2)}`} detail="Approved or remitted" tone="success" />
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

        <div className="grid gap-3 xl:grid-cols-[minmax(320px,0.9fr)_190px_170px_auto_auto]">
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

          <select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)} className="rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-teal focus:ring-2 focus:ring-teal-soft">
            <option value="all">All channels</option>
            {channels.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
          </select>

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

        {visibleSelectedClaim ? (
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
  sendClaimForClientAuthentication,
  authenticateEmailClaim,
  submitEmailClaim,
}) {
  const pack = claim.emailSubmission || {};
  const requiredDocuments = pack.requiredDocuments || ['Claim form', 'Itemised invoice', 'Clinical notes'];
  const attachments = pack.attachments || claim.attachments || [];
  const authenticated = claim.status === 'Client authenticated' || claim.status === 'Email submitted';
  const sent = claim.status === 'Email submitted';

  return (
    <div className="grid min-w-0 items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
      <div className="min-w-0 space-y-4">
        <InfoList
          title="Email claim pack"
          rows={[
            ['Provider email', pack.providerEmail || 'Not configured'],
            ['Claim form', pack.claimForm || 'Provider form not selected'],
            ['Prepared by', pack.preparedBy || 'Not prepared'],
            ['Review link', pack.reviewLink || 'Not generated'],
            ['Authentication', pack.authentication || 'Not started'],
            ['Email subject', pack.subject || `Claim ${claim.id} · ${claim.patient}`],
          ]}
        />

        <div className="rounded-lg bg-surface/60 p-4">
          <p className="text-sm font-semibold text-ink">Document checklist</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {requiredDocuments.map((document) => (
              <ChecklistItem key={document} done={attachments.some((attachment) => String(attachment.name || attachment).toLowerCase().includes(document.toLowerCase().split(' ')[0]))} label={document} />
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg bg-surface/60 p-4">
        <p className="text-sm font-semibold text-ink">Client-assisted workflow</p>
        <div className="mt-3 space-y-2 text-sm">
          <ChecklistItem done={Boolean(pack.claimForm) || claim.status !== 'Draft'} label="Form prepared by staff" />
          <ChecklistItem done={claim.status !== 'Form prepared' && claim.status !== 'Draft'} label="Review link sent to client" />
          <ChecklistItem done={authenticated} label="Client OTP declaration captured" />
          <ChecklistItem done={sent} label="Claim pack emailed to insurer" />
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {claim.status === 'Draft' ? (
            <ActionButton onClick={() => prepareEmailClaimForm(claim.id)} icon={Mail}>Prepare form</ActionButton>
          ) : null}
          {claim.status === 'Form prepared' ? (
            <ActionButton onClick={() => sendClaimForClientAuthentication(claim.id)} icon={Send}>Send to client</ActionButton>
          ) : null}
          {claim.status === 'Awaiting client authentication' ? (
            <ActionButton onClick={() => authenticateEmailClaim(claim.id)} icon={ShieldCheck}>Record authentication</ActionButton>
          ) : null}
          {claim.status === 'Client authenticated' ? (
            <ActionButton onClick={() => submitEmailClaim(claim.id)} icon={Mail}>Submit by email</ActionButton>
          ) : null}
          {sent ? (
            <p className="rounded-md border border-success/25 bg-success-soft px-3 py-2 text-xs text-success-deep">
              Submission reference: {claim.externalReference || 'Email message id pending'}
            </p>
          ) : null}
        </div>
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
